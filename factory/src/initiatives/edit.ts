/**
 * What the user can change in a roadmap, and the rules that keep it coherent.
 *
 * A roadmap is a plan, so the user owns it: rename it, reword a phase, skip one, add one, set a backlog
 * item aside or promote it into a phase. What cannot change is history - a phase that is running, in
 * review or merged keeps its scope and its status. Everything is checked before anything is written, so
 * an edit either happens whole or not at all.
 */
import { z } from 'zod';

import type { InitiativeStore, InitiativeWithPhases, PhaseRow } from './store.ts';

const text = (max: number) => z.string().trim().max(max);
const items = z.array(z.string().trim().min(1).max(300)).max(30);

export const initiativeEditSchema = z
  .object({
    title: text(120).min(1).optional(),
    goal: text(2000).optional(),
    /** The user can shelve a project and take it back; `DONE` is not theirs to set - merging does it. */
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
    phases: z
      .array(
        z
          .object({
            id: z.string().min(1),
            title: text(120).min(1).optional(),
            goal: text(2000).optional(),
            scope: items.optional(),
            acceptance: items.optional(),
            status: z.enum(['PLANNED', 'SKIPPED']).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    addPhases: z
      .array(z.object({ title: text(120).min(1), goal: text(2000).optional(), scope: items.optional(), acceptance: items.optional() }).strict())
      .max(8)
      .optional(),
    backlog: z
      .array(z.object({ id: z.string().min(1), status: z.enum(['OPEN', 'DISMISSED', 'PROMOTED']), phaseId: z.string().min(1).optional() }).strict())
      .max(50)
      .optional(),
  })
  .strict();
export type InitiativeEdit = z.infer<typeof initiativeEditSchema>;

/** A change the user asked for that the roadmap cannot take. The message is for them. */
export class EditRefused extends Error {}

const STATE_WORDS: Record<PhaseRow['status'], string> = {
  PLANNED: 'waiting',
  RUNNING: 'running',
  IN_REVIEW: 'in review',
  MERGED: 'merged',
  SKIPPED: 'skipped',
};

const label = (phase: PhaseRow): string => `Phase ${phase.ordinal} ("${phase.title}")`;

export function parseInitiativeEdit(raw: string): InitiativeEdit {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new EditRefused('The edit is not valid JSON.');
  }
  const parsed = initiativeEditSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EditRefused(`The edit is not valid: ${issue ? `${issue.path.join('.') || 'edit'} - ${issue.message}` : 'unknown reason'}.`);
  }
  return parsed.data;
}

/** Checks the whole edit against the roadmap as it is. Throws `EditRefused` on the first problem. */
export function checkEdit(initiative: InitiativeWithPhases, edit: InitiativeEdit, backlogIds: ReadonlySet<string>): void {
  const touched = Object.values(edit).some((value) => value !== undefined && (!Array.isArray(value) || value.length > 0));
  if (!touched) throw new EditRefused('There is nothing to change.');

  const byId = new Map(initiative.phases.map((phase) => [phase.id, phase]));

  for (const change of edit.phases ?? []) {
    const phase = byId.get(change.id);
    if (!phase) throw new EditRefused(`${change.id} is not a phase of "${initiative.title}".`);

    if (change.status !== undefined && change.status !== phase.status) {
      const allowed = (phase.status === 'PLANNED' && change.status === 'SKIPPED') || (phase.status === 'SKIPPED' && change.status === 'PLANNED');
      if (!allowed) throw new EditRefused(`${label(phase)} is ${STATE_WORDS[phase.status]}: it cannot be made ${STATE_WORDS[change.status]} by hand.`);
    }

    const rewording = change.goal !== undefined || change.scope !== undefined || change.acceptance !== undefined;
    if (rewording && phase.status !== 'PLANNED' && phase.status !== 'SKIPPED') {
      throw new EditRefused(`${label(phase)} is ${STATE_WORDS[phase.status]}: only its title can be changed now.`);
    }
  }

  for (const change of edit.backlog ?? []) {
    if (!backlogIds.has(change.id)) throw new EditRefused(`${change.id} is not in the backlog of "${initiative.title}".`);
    if (change.status === 'PROMOTED') {
      const target = change.phaseId ? byId.get(change.phaseId) : undefined;
      if (!target) throw new EditRefused(`${change.id} cannot be promoted: say which phase of this roadmap it goes to.`);
      if (target.status !== 'PLANNED') throw new EditRefused(`${change.id} cannot go to ${label(target)}, which is ${STATE_WORDS[target.status]}.`);
    }
  }

  if (initiative.status === 'ARCHIVED' && edit.status === undefined && (edit.addPhases?.length ?? 0) > 0) {
    throw new EditRefused('This project is archived: take it back before adding phases.');
  }
}

/** Applies a checked edit. Returns the roadmap as it is now. */
export async function applyInitiativeEdit(store: InitiativeStore, initiativeId: string, edit: InitiativeEdit): Promise<InitiativeWithPhases> {
  const initiative = await store.getInitiative(initiativeId);
  if (!initiative) throw new EditRefused(`There is no project ${initiativeId}.`);
  const backlog = await store.listBacklog(initiativeId);
  checkEdit(initiative, edit, new Set(backlog.map((item) => item.id)));

  if (edit.title !== undefined || edit.goal !== undefined || edit.status !== undefined) {
    await store.updateInitiative(initiativeId, {
      ...(edit.title !== undefined ? { title: edit.title } : {}),
      ...(edit.goal !== undefined ? { goal: edit.goal } : {}),
      ...(edit.status !== undefined ? { status: edit.status } : {}),
    });
  }

  for (const change of edit.phases ?? []) {
    const { id, ...patch } = change;
    await store.updatePhase(id, patch);
  }

  for (const phase of edit.addPhases ?? []) {
    // A phase added at the end waits for the one before it, like the architect's own roadmap.
    const last = Math.max(0, ...(await store.getInitiative(initiativeId))!.phases.map((existing) => existing.ordinal));
    await store.addPhase(initiativeId, { ...phase, ...(last > 0 ? { dependsOnOrdinals: [last] } : {}) });
  }

  for (const change of edit.backlog ?? []) {
    await store.setBacklogStatus(change.id, change.status);
    if (change.status === 'PROMOTED' && change.phaseId) {
      const item = backlog.find((candidate) => candidate.id === change.id)!;
      await store.appendNotes(change.phaseId, [{ source: 'user', text: `From the backlog: ${item.text}` }]);
    }
  }

  // Skipping or un-skipping can finish a project or reopen it. Only ACTIVE and DONE move: an archived
  // project is the user's to take back, whatever its phases do.
  const after = (await store.getInitiative(initiativeId))!;
  const finished = after.phases.every((phase) => phase.status === 'MERGED' || phase.status === 'SKIPPED');
  if (finished && after.status === 'ACTIVE') await store.updateInitiative(initiativeId, { status: 'DONE' });
  if (!finished && after.status === 'DONE') await store.updateInitiative(initiativeId, { status: 'ACTIVE' });
  await store.log(initiativeId, 'edited_by_user', { fields: Object.keys(edit) });
  return (await store.getInitiative(initiativeId))!;
}
