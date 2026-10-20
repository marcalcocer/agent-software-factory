/**
 * Phasing, without any I/O: how the architect's proposal becomes a roadmap, what the agents are told
 * about the initiative they are working on, and what a run of one phase is asked to do.
 *
 * The rules that matter live here, apart from the database and the model, so they can be checked on
 * their own: how many phases are too many, what a phase has to say for itself, what "ready to start"
 * means, and the exact words an agent reads.
 */
import { cleanTitle } from '../tools/run-naming.ts';
import type { ExecutionPlan } from '../utils/schemas.ts';
import type { BacklogRow, InitiativeWithPhases, NewPhase, PhaseRow, PhaseStatus } from './store.ts';

/** More than this is a plan nobody will follow. */
export const MAX_PHASES = 8;
const MAX_ITEMS = 8;
const ITEM_MAX_CHARS = 200;

/** The text on one line, cut to `max` characters with an ellipsis. */
export const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}\u2026`;
};

const items = (list: string[] | undefined): string[] => {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of list ?? []) {
    const item = clip(raw, ITEM_MAX_CHARS);
    if (item === '' || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    kept.push(item);
    if (kept.length === MAX_ITEMS) break;
  }
  return kept;
};

/* -------------------------------------------------------------------------- */
/* The architect's proposal                                                    */
/* -------------------------------------------------------------------------- */

export interface Roadmap {
  title: string;
  phases: NewPhase[];
}

/**
 * The roadmap the architect proposed, cleaned - or `null` when it did not propose one, or what it
 * proposed is not a roadmap (fewer than two phases, none with a title).
 *
 * Phase 1 is always the phase the plan is for. Titles are cleaned like any title, scope and acceptance
 * are trimmed and de-duplicated, a dependency can only point at an earlier phase, and nothing past
 * `MAX_PHASES` is kept: the extra ones are noise, and the first ones are what the user will review.
 */
export function roadmapFromPlan(plan: Pick<ExecutionPlan, 'phasing' | 'summary'>, fallbackTitle: string): Roadmap | null {
  const phasing = plan.phasing;
  if (!phasing?.phased) return null;

  const phases: NewPhase[] = [];
  for (const raw of phasing.phases) {
    if (phases.length === MAX_PHASES) break;
    const title = cleanTitle(raw.title);
    if (title === '') continue;
    const position = phases.length + 1;
    const wanted = [...new Set((raw.dependsOn ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n < position))];
    phases.push({
      title,
      goal: clip(raw.goal ?? '', 400),
      scope: items(raw.scope),
      acceptance: items(raw.acceptance),
      // Nothing (valid) named: it waits for the phase before it. Starting a phase against code that
      // the one before it is about to change is the expensive mistake; independence is for the user to say.
      dependsOnOrdinals: wanted.length > 0 ? wanted : [position - 1],
    });
  }
  if (phases.length < 2) return null;
  phases[0] = { ...phases[0]!, dependsOnOrdinals: [] };

  return { title: cleanTitle(phasing.initiativeTitle) || cleanTitle(fallbackTitle) || phases[0]!.title, phases };
}

/* -------------------------------------------------------------------------- */
/* What an agent reads                                                         */
/* -------------------------------------------------------------------------- */

const STATUS_WORDS: Record<PhaseStatus, string> = {
  PLANNED: 'planned',
  RUNNING: 'in progress',
  IN_REVIEW: 'pull request open',
  MERGED: 'delivered',
  SKIPPED: 'skipped',
};

const bullets = (list: string[], indent = '  '): string => list.map((item) => `${indent}- ${item}`).join('\n');

/**
 * The initiative as the architect reads it when it plans one phase: the goal, what the user decided,
 * every phase with where it stands and what it covers, what the finished ones delivered, what the
 * reconciler noted about this one, and what is waiting in the backlog. A phase that is not this one is
 * out of scope - saying so is what keeps a phase from swallowing the next.
 */
export function renderInitiativeContext(
  initiative: InitiativeWithPhases,
  currentPhaseId: string | null,
  backlog: BacklogRow[] = [],
): string {
  const current = initiative.phases.find((phase) => phase.id === currentPhaseId) ?? null;
  const lines: string[] = [`Initiative ${initiative.id}: ${initiative.title}`, '', `Goal, as the user gave it: ${clip(initiative.goal, 1_200)}`];

  if (initiative.decisions.length > 0) {
    lines.push('', 'What the user decided (authoritative):');
    for (const decision of initiative.decisions) {
      lines.push(`  Asked: ${decision.questions.map((q) => clip(q, 240)).join(' | ')}`, `  Answered: ${clip(decision.answer, 1_500)}`);
    }
  }
  if (initiative.constraints.length > 0) lines.push('', 'Constraints:', bullets(initiative.constraints));

  lines.push('', 'Phases:');
  for (const phase of initiative.phases) {
    const mark = phase.id === currentPhaseId ? ' <- THE PHASE YOU ARE PLANNING' : '';
    lines.push(`  ${phase.ordinal}. ${phase.title} [${STATUS_WORDS[phase.status]}]${mark}`);
    if (phase.id !== currentPhaseId && phase.goal) lines.push(`     ${clip(phase.goal, 240)}`);
    if (phase.status === 'MERGED' && phase.summary) lines.push(`     Delivered: ${clip(phase.summary, 500)}`);
    if (phase.status === 'PLANNED' && phase.id !== currentPhaseId && phase.scope.length > 0) {
      lines.push(`     Covers: ${phase.scope.map((s) => clip(s, 120)).join('; ')}`);
    }
  }

  if (current) {
    lines.push('', `Your phase - ${current.ordinal}. ${current.title}`);
    if (current.goal) lines.push(`  Goal: ${current.goal}`);
    if (current.scope.length > 0) lines.push('  Scope:', bullets(current.scope, '    '));
    if (current.acceptance.length > 0) lines.push('  Acceptance:', bullets(current.acceptance, '    '));
    const later = initiative.phases.filter((phase) => phase.ordinal > current.ordinal && phase.status !== 'SKIPPED');
    if (later.length > 0) {
      lines.push('  Out of scope - these are later phases:', bullets(later.map((phase) => `Phase ${phase.ordinal}: ${phase.title}`), '    '));
    }
    if (current.notes.length > 0) {
      lines.push('  Notes on this phase (what changed since the roadmap was written):');
      for (const note of current.notes) lines.push(`    - [${note.source}] ${clip(note.text, 400)}`);
    }
  }

  const open = backlog.filter((item) => item.status === 'OPEN');
  if (open.length > 0) {
    lines.push('', 'Backlog (seen on the way, not asked for; take one only if it belongs to your phase):');
    for (const item of open.slice(0, 12)) lines.push(`  - [${item.source}${item.severity ? `/${item.severity}` : ''}] ${clip(item.text, 220)}`);
  }
  return lines.join('\n');
}

/**
 * The roadmap as the review triage reads it, with the ids it must answer by. The triage decides whether
 * a comment is about this pull request or about a later phase, so it needs each phase's own words - and
 * the rule for telling them apart - not the whole initiative.
 *
 * `null` when there is nothing to defer to: a project of one phase has no later phase, and the review
 * of a plain task keeps working as it always did.
 */
export function renderRoadmapForTriage(initiative: InitiativeWithPhases, currentPhaseId: string): string | null {
  const current = initiative.phases.find((phase) => phase.id === currentPhaseId);
  if (!current) return null;
  const others = initiative.phases.filter((phase) => phase.id !== current.id && phase.status !== 'SKIPPED');
  if (others.length === 0) return null;

  const lines = [
    `This pull request is phase ${current.ordinal} of ${others.length + 1} of "${initiative.title}" (${initiative.id}).`,
    `Its own scope: ${current.scope.length > 0 ? current.scope.map((item) => clip(item, 160)).join('; ') : clip(current.goal || current.title, 240)}`,
    '',
    'Phases (answer `targetPhase` with the id, exactly):',
  ];
  for (const phase of initiative.phases) {
    if (phase.status === 'SKIPPED') continue;
    const where = phase.id === current.id ? 'THIS PULL REQUEST' : STATUS_WORDS[phase.status];
    lines.push(`  ${phase.id} - ${phase.ordinal}. ${phase.title} [${where}]`);
    if (phase.id !== current.id && phase.status === 'PLANNED') {
      if (phase.goal) lines.push(`     Goal: ${clip(phase.goal, 240)}`);
      if (phase.scope.length > 0) lines.push(`     Covers: ${phase.scope.map((item) => clip(item, 120)).join('; ')}`);
    }
  }
  lines.push(
    '',
    'A comment asking for something one of the PLANNED phases covers is `FUTURE_PHASE` with that phase\'s id as `targetPhase`.',
    'A request beyond this pull request that no planned phase covers is `FUTURE_PHASE` with `targetPhase` "NEW".',
    'A phase that is delivered cannot be a target: if the comment is about something it delivered, that is a defect or a change to it - classify it as such.',
  );
  return lines.join('\n');
}

/**
 * What a run of one phase is asked to do: the phase as a request. The architect receives this as the
 * task, so it reads like one - and states the phase's own words, not a paraphrase.
 */
export function phaseTask(initiative: Pick<InitiativeWithPhases, 'title' | 'phases'>, phase: PhaseRow): string {
  const total = initiative.phases.filter((p) => p.status !== 'SKIPPED').length;
  const lines = [`Phase ${phase.ordinal} of ${total} of "${initiative.title}": ${phase.title}`];
  if (phase.goal) lines.push('', `Goal: ${phase.goal}`);
  if (phase.scope.length > 0) lines.push('', 'Scope:', bullets(phase.scope, ''));
  if (phase.acceptance.length > 0) lines.push('', 'Acceptance:', bullets(phase.acceptance, ''));
  const requests = phase.notes.filter((note) => note.source === 'user-request');
  if (requests.length > 0) {
    lines.push('', 'The user asked for these while reviewing an earlier phase, and agreed they belong here:', bullets(requests.map((note) => note.text), ''));
  }
  const reconciled = phase.notes.filter((note) => note.source === 'reconciler');
  if (reconciled.length > 0) lines.push('', 'Since this phase was planned:', bullets(reconciled.map((note) => note.text), ''));
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* The pull request's roadmap                                                  */
/* -------------------------------------------------------------------------- */

export interface RoadmapView {
  title: string;
  /** The phase this pull request is. */
  current: number;
  total: number;
  phases: Array<{ ordinal: number; title: string; status: PhaseStatus }>;
}

/** The roadmap as a pull request shows it - or `null` for a task with one phase, which has none to show. */
export function roadmapView(initiative: InitiativeWithPhases | null, currentPhaseId: string | null): RoadmapView | null {
  if (!initiative) return null;
  const phases = initiative.phases.filter((phase) => phase.status !== 'SKIPPED' || phase.id === currentPhaseId);
  const current = phases.find((phase) => phase.id === currentPhaseId);
  if (phases.length < 2 || !current) return null;
  return {
    title: initiative.title,
    current: current.ordinal,
    total: phases.length,
    phases: phases.map((phase) => ({ ordinal: phase.ordinal, title: phase.title, status: phase.status })),
  };
}

/** Whether a phase can start: planned, and everything it depends on is delivered (or skipped). */
export function readiness(initiative: Pick<InitiativeWithPhases, 'phases'>, phase: PhaseRow): { ready: true } | { ready: false; reason: string } {
  if (phase.status !== 'PLANNED') return { ready: false, reason: `Phase ${phase.ordinal} is ${STATUS_WORDS[phase.status]}, not waiting to be started.` };
  const waiting = initiative.phases.filter((other) => phase.dependsOn.includes(other.id) && other.status !== 'MERGED' && other.status !== 'SKIPPED');
  if (waiting.length > 0) {
    return {
      ready: false,
      reason: `It builds on ${waiting.map((other) => `phase ${other.ordinal} ("${other.title}")`).join(' and ')}, which ${waiting.length === 1 ? 'is' : 'are'} not merged yet: ${
        waiting.length === 1 ? 'it' : 'they'
      } would be planned against code that is about to change.`,
    };
  }
  return { ready: true };
}
