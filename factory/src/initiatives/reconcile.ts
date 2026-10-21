/**
 * Reconciling the roadmap with what a merged phase really delivered.
 *
 * The digest and the way an answer is applied are pure; gathering what the runs did reads the run
 * directories; the call to the model is one agent call in `reconcilePhase`. If the agent cannot answer
 * nothing changes except that the phase is marked delivered - the next phase is then planned from the
 * roadmap as written, which is what happened before this existed.
 */
import fs from 'node:fs';
import path from 'node:path';

import { phaseReconcilerAgent } from '../agents/phase-reconciler.agent.ts';
import { appendEvent, generateRunId, writeArtifact } from '../tools/logger-tools.ts';
import { explainAgentFailure } from '../tools/pr-merge-rules.ts';
import { pullRequestKey } from '../tools/pr-registry.ts';
import { composePrompt, invokeAgent, promptSection } from '../utils/agent-runner.ts';
import { getFactoryConfig } from '../utils/factory-config.ts';
import { phaseReconcileSchema, type PhaseReconcile } from '../utils/schemas.ts';
import { clip } from './phasing.ts';
import {
  withStore,
  type BacklogRow,
  type InitiativeStore,
  type InitiativeWithPhases,
  type PhaseRow,
  type ScopeDecisionRow,
} from './store.ts';

/* -------------------------------------------------------------------------- */
/* What the runs of a phase did                                                */
/* -------------------------------------------------------------------------- */

export interface RunDigest {
  runId: string;
  round: number;
  kind: string;
  /** What this run was asked to do (a round: the task the triage wrote). */
  task: string;
  /** The developer's own account of its first attempt: the bulk of the work. */
  summary: string;
  /** What each later attempt said it fixed (after QA or review sent it back). */
  fixes: string[];
  /** Every file any attempt touched. */
  files: string[];
  followUps: string[];
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

/**
 * Every run of a phase's task - the run that opened the pull request and each round on it - oldest
 * first, with what its developer reported. Read from the run directories: they are the record of what
 * happened, and the roadmap only has what was planned.
 */
export function digestOfRuns(rootRunId: string, logDir: string = getFactoryConfig().logDir): RunDigest[] {
  if (!fs.existsSync(logDir)) return [];
  const digests: RunDigest[] = [];

  for (const name of fs.readdirSync(logDir).sort()) {
    const meta = readJson<{ task?: string; kind?: string; round?: number; rootRunId?: string }>(path.join(logDir, name, 'run.json'));
    if (!meta || meta.kind === 'pr-feedback' || (meta.rootRunId ?? name) !== rootRunId) continue;

    // Attempt 1 is the work; a later attempt is the fix after QA or review sent it back, and says only
    // what it fixed (in the real UI refactor: 19 files, then 3). What the run did is all of them.
    const attempts = fs
      .readdirSync(path.join(logDir, name))
      .filter((file) => /^02-developer(\.attempt-\d+)?\.json$/.test(file))
      .sort((a, b) => Number(/attempt-(\d+)/.exec(a)?.[1] ?? 1) - Number(/attempt-(\d+)/.exec(b)?.[1] ?? 1));

    let summary = '';
    const fixes: string[] = [];
    const files = new Set<string>();
    const followUps = new Set<string>();
    attempts.forEach((file, index) => {
      const developer = readJson<{ data?: { summary?: string; changedFiles?: Array<{ path: string }>; followUps?: string[] } }>(path.join(logDir, name, file))?.data;
      if (!developer) return;
      if (index === 0) summary = developer.summary ?? '';
      else if (developer.summary) fixes.push(developer.summary);
      for (const changed of developer.changedFiles ?? []) files.add(changed.path);
      for (const followUp of developer.followUps ?? []) followUps.add(followUp);
    });

    digests.push({
      runId: name,
      round: meta.round ?? 1,
      kind: meta.kind ?? 'run',
      task: meta.task ?? '',
      summary,
      fixes,
      files: [...files],
      followUps: [...followUps],
    });
  }
  return digests.sort((a, b) => a.round - b.round || a.runId.localeCompare(b.runId));
}

/* -------------------------------------------------------------------------- */
/* The digest the agent reads                                                  */
/* -------------------------------------------------------------------------- */

export interface ReconcileInput {
  initiative: InitiativeWithPhases;
  merged: PhaseRow;
  runs: RunDigest[];
  /** The pull request's title and the first paragraph of its description. */
  pullRequest: { title: string; summary: string } | null;
  decisions: ScopeDecisionRow[];
  backlog: BacklogRow[];
}

export function buildReconcilePrompt(input: ReconcileInput): { prompt: string; remaining: PhaseRow[] } {
  const { initiative, merged } = input;
  const remaining = initiative.phases.filter((phase) => phase.status === 'PLANNED');

  const list = (items: string[]): string => items.map((item) => `- ${clip(item, 200)}`).join('\n');
  const phaseBlock = (phase: PhaseRow): string =>
    [
      `### ${phase.id} - ${phase.ordinal}. ${phase.title}`,
      phase.goal ? `Goal: ${clip(phase.goal, 300)}` : '',
      phase.scope.length > 0 ? `Scope:\n${list(phase.scope)}` : '',
      phase.acceptance.length > 0 ? `Acceptance:\n${list(phase.acceptance)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

  const runs = input.runs.map((run) =>
    [
      `### ${run.round === 1 ? 'The first run' : `Round ${run.round}`} (${run.runId})`,
      run.round > 1 && run.task ? `Asked: ${clip(run.task, 700)}` : '',
      run.summary ? `The developer says: ${clip(run.summary, 900)}` : 'The developer left no report.',
      ...run.fixes.map((fix) => `Then, sent back by QA or review, it fixed: ${clip(fix, 300)}`),
      run.files.length > 0 ? `Files changed (${run.files.length}): ${run.files.slice(0, 30).join(', ')}${run.files.length > 30 ? ', ...' : ''}` : '',
      run.followUps.length > 0 ? `Follow-ups it named:\n${list(run.followUps)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  const decisions = input.decisions.map(
    (decision) => `- ${decision.decision === 'DEFER' ? `deferred to ${decision.targetPhaseId ?? 'a new phase'}` : 'done in this phase'}: ${clip(decision.excerpt, 200)}`,
  );

  const prompt = composePrompt(
    '# Phase delivered: reconcile the roadmap',
    '',
    `Initiative "${initiative.title}". Phase ${merged.ordinal} of ${initiative.phases.length} was just merged.`,
    promptSection('The phase as planned', phaseBlock(merged)),
    promptSection('What really happened, run by run', runs.join('\n\n')),
    promptSection('The pull request', input.pullRequest ? `${input.pullRequest.title}\n${input.pullRequest.summary}` : ''),
    promptSection('What the user decided about review comments', decisions.join('\n')),
    promptSection('The remaining phases', remaining.map(phaseBlock).join('\n\n')),
    promptSection('Backlog already kept', input.backlog.filter((item) => item.status === 'OPEN').slice(0, 15).map((item) => `- ${clip(item.text, 160)}`).join('\n')),
    [
      '',
      '## Instructions',
      '',
      remaining.length > 0
        ? '1. For each remaining phase that the delivery touches, say DONE, PARTIAL (with what is left) or leave it out. Use the ids above.'
        : '1. No phase remains: leave `phases` empty.',
      '2. Base every DONE or PARTIAL on a file or a summary above.',
      '3. Write `summary` from what the runs report, not from the plan.',
      '',
    ].join('\n'),
  );
  return { prompt, remaining };
}

/* -------------------------------------------------------------------------- */
/* Applying the answer                                                         */
/* -------------------------------------------------------------------------- */

export interface ReconcileReport {
  summary: string;
  /** What changed for each remaining phase. */
  changes: Array<{ phaseId: string; ordinal: number; status: 'DONE' | 'PARTIAL'; note: string }>;
  backlogAdded: number;
  /** `agent`, or `none` when the agent could not answer (the phase is still marked delivered). */
  source: 'agent' | 'none';
  note?: string;
}

/**
 * Puts the agent's conclusions into the roadmap. It trusts nothing it cannot check: an id that is not a
 * remaining phase of this initiative is ignored, a `DONE` phase is skipped (not deleted - the record of
 * why stays), a `PARTIAL` one keeps its other fields and takes the new scope.
 */
export async function applyReconcile(
  store: InitiativeStore,
  initiative: InitiativeWithPhases,
  merged: PhaseRow,
  answer: PhaseReconcile,
): Promise<ReconcileReport> {
  const planned = new Map(initiative.phases.filter((phase) => phase.status === 'PLANNED').map((phase) => [phase.id, phase]));
  const changes: ReconcileReport['changes'] = [];

  // The summary is also what says "this phase was reconciled": it is never left empty.
  await store.updatePhase(merged.id, { summary: clip(answer.summary, 1_000) || 'Delivered.' });

  for (const entry of answer.phases) {
    const phase = planned.get(entry.phaseId);
    if (!phase || entry.status === 'UNCHANGED') continue;
    const note = clip(entry.note, 400);

    if (entry.status === 'DONE') {
      await store.updatePhase(phase.id, { status: 'SKIPPED' });
      await store.appendNotes(phase.id, [{ source: 'reconciler', text: `Already delivered - ${note || `by phase ${merged.ordinal}`}` }]);
    } else {
      const remainingScope = entry.remainingScope.map((item) => clip(item, 200)).filter(Boolean);
      if (remainingScope.length > 0) await store.updatePhase(phase.id, { scope: remainingScope });
      await store.appendNotes(phase.id, [{ source: 'reconciler', text: note || `Part of it was delivered by phase ${merged.ordinal}.` }]);
    }
    changes.push({ phaseId: phase.id, ordinal: phase.ordinal, status: entry.status, note });
  }

  const backlogAdded = await store.addBacklog(
    initiative.id,
    answer.backlog.map((item) => ({
      source: 'reconciler',
      text: item.text,
      severity: item.severity,
      phaseId: merged.id,
      suggestedPhaseId: item.suggestedPhaseId && planned.has(item.suggestedPhaseId) ? item.suggestedPhaseId : null,
    })),
  );
  await store.log(initiative.id, 'phase_reconciled', { phaseId: merged.id, changes: changes.length, backlogAdded });

  // `markMerged` closes an initiative when nothing is left to do; skipping the last open phase here
  // is the other way to get there.
  const after = await store.getInitiative(initiative.id);
  if (after && after.status === 'ACTIVE' && after.phases.every((phase) => phase.status === 'MERGED' || phase.status === 'SKIPPED')) {
    await store.updateInitiative(initiative.id, { status: 'DONE' });
  }
  return { summary: answer.summary, changes, backlogAdded, source: 'agent' };
}

/* -------------------------------------------------------------------------- */
/* The whole thing                                                             */
/* -------------------------------------------------------------------------- */

const firstParagraph = (body: string): string => clip(body.split(/\n\s*\n/).find((part) => part.trim() !== '' && !part.trim().startsWith('#')) ?? '', 500);

/**
 * Reconciles the roadmap after `phaseId` was merged. A phase that is not merged, or that was already
 * reconciled, is left alone unless `force`. With no phase left to plan there is nothing to compare, so no
 * model is asked.
 */
export async function reconcilePhase(options: { phaseId: string; force?: boolean }): Promise<ReconcileReport | null> {
  const config = getFactoryConfig();

  const prepared = await withStore(async (store) => {
    const merged = await store.getPhase(options.phaseId);
    if (!merged || merged.status !== 'MERGED') return null;
    const initiative = await store.getInitiative(merged.initiativeId);
    if (!initiative) return null;
    if (merged.summary && !options.force) return null;

    const remaining = initiative.phases.filter((phase) => phase.status === 'PLANNED');
    const prKey = merged.prNumber ? pullRequestKey(initiative.repoPath, merged.prNumber) : null;
    const body = merged.rootRunId
      ? readJson<{ data?: { pullRequest?: { title?: string; body?: string } } }>(path.join(config.logDir, merged.rootRunId, '08-pull-request.json'))?.data?.pullRequest
      : undefined;

    return {
      initiative,
      merged,
      remaining,
      input: {
        initiative,
        merged,
        runs: merged.rootRunId ? digestOfRuns(merged.rootRunId, config.logDir) : [],
        pullRequest: body?.title ? { title: body.title, summary: firstParagraph(body.body ?? '') } : null,
        decisions: prKey ? await store.listScopeDecisions(prKey) : [],
        backlog: await store.listBacklog(initiative.id),
      } satisfies ReconcileInput,
    };
  });
  if (!prepared) return null;
  const { initiative, merged, remaining, input } = prepared;

  // What the developer said it did: the record when nobody compares it with the roadmap.
  const ownWords = clip(input.runs.map((run) => run.summary).find(Boolean) ?? '', 1_000) || 'Delivered.';

  // Nothing left to plan: record what was delivered, and spare the call.
  if (remaining.length === 0) {
    await withStore((store) => store.updatePhase(merged.id, { summary: ownWords }));
    return { summary: ownWords, changes: [], backlogAdded: 0, source: 'none', note: 'No phase is left to plan.' };
  }

  // The trace of this call (tokens, model) lives under a run id of its own, like the squash-message
  // draft's: it is not a run the user sees, so it gets no run.json.
  const traceId = generateRunId(`${path.basename(initiative.repoPath)}-reconcile-${merged.ordinal}`);

  try {
    const { prompt } = buildReconcilePrompt(input);
    const result = await invokeAgent({
      agent: phaseReconcilerAgent,
      role: 'phase-reconciler',
      step: 'phase-reconcile',
      runId: traceId,
      repoPath: initiative.repoPath,
      repoName: path.basename(initiative.repoPath),
      prompt,
      schema: phaseReconcileSchema,
      dryRunResult: { summary: '[dry-run] The phase delivered what was planned.', phases: [], backlog: [] },
      timeoutMs: 120_000,
      maxRungs: 2,
    });
    // A rehearsal asked no model; its stand-in answer has no business in the real roadmap.
    if (result.dryRun) {
      await withStore((store) => store.updatePhase(merged.id, { summary: ownWords }));
      return { summary: ownWords, changes: [], backlogAdded: 0, source: 'none', note: 'Dry run: the AI was not asked, so the roadmap is as it was written.' };
    }
    writeArtifact({ runId: traceId, step: 'phase-reconcile', status: 'agent', model: result.servedByModel, durationMs: result.durationMs, data: result.object });

    return await withStore(async (store) => {
      const fresh = (await store.getInitiative(initiative.id)) ?? initiative;
      return await applyReconcile(store, fresh, merged, result.object);
    });
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    appendEvent(traceId, { type: 'phase_reconcile_failed', error: message });
    // The phase IS delivered; only the comparison is missing. It stays UNcompared (no summary): the summary is
    // what says "compared", and stamping it here hid the retry - with the model unavailable (a login that
    // expired) the user was left with a phase the roadmap said was done and no way to ask again. The reason is
    // kept with the phase, where the roadmap shows it next to the button.
    const note = `The AI could not compare the roadmap with what was delivered (${explainAgentFailure(message)}). The remaining phases are as they were written.`;
    await withStore((store) => store.appendNotes(merged.id, [{ source: 'factory', text: note }]));
    return { summary: '', changes: [], backlogAdded: 0, source: 'none', note };
  }
}
