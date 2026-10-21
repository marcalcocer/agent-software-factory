import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyRuns, RUN, readJson } from '../../fixtures';

// `invokeAgent` is the only way to the model; everything else is real code on a real store.
vi.mock('../src/utils/agent-runner.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/agent-runner.ts')>()),
  invokeAgent: vi.fn(),
}));
import { invokeAgent } from '../src/utils/agent-runner.ts';

import { applyReconcile, buildReconcilePrompt, digestOfRuns, reconcilePhase, type ReconcileInput } from '../src/initiatives/reconcile.ts';
import { withStore } from '../src/initiatives/store.ts';
import { pullRequestKey } from '../src/tools/pr-registry.ts';
import type { PhaseReconcile } from '../src/utils/schemas.ts';

const ask = vi.mocked(invokeAgent);
const REPO = '/home/dev/workspace/invest-track';
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

let logs: string;

beforeEach(() => {
  logs = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-reconcile-'));
  vi.stubEnv('FACTORY_LOG_DIR', logs);
  copyRuns(logs, [RUN.round1, RUN.round2, RUN.prTriage, RUN.mergeSummary]);
});
afterEach(() => {
  ask.mockReset();
  fs.rmSync(logs, { recursive: true, force: true });
});

/** Phase 1 (the real round 1 and round 2) is merged; three phases are left. */
async function mergedProject() {
  return await withStore(async (store) => {
    const created = await store.createInitiative({ repoPath: REPO, title: 'Redesign', goal: 'Redesign the frontend', firstPhase: { title: 'Foundation' } });
    await store.linkRun(created.phases[0]!.id, { taskId: 'f0042', rootRunId: RUN.round1, branch: 'factory/f0042/feat-redesign' });
    const set = await store.setRoadmap(created.id, {
      title: 'Redesign the frontend',
      phases: [
        { title: 'Foundation', scope: ['Design tokens', 'Primitives'] },
        { title: 'Privacy mode', goal: 'Hide amounts on request', scope: ['Mask every amount when privacy mode is on', 'A toggle in the header'], acceptance: ['No amount is readable in privacy mode'] },
        { title: 'Screens', scope: ['Migrate the screens'] },
        { title: 'Cleanup' },
      ],
    });
    await store.linkPullRequest(set.phases[0]!.id, { number: 8, url: 'https://github.com/o/r/pull/8' });
    await store.markMerged(set.phases[0]!.id);
    return (await store.getInitiative(set.id))!;
  });
}

const answer = (overrides: Partial<PhaseReconcile> = {}): PhaseReconcile => ({
  summary: 'Foundation delivered, and round 2 also wired privacy masking into the investment page.',
  phases: [],
  backlog: [],
  ...overrides,
});

const reply = (object: PhaseReconcile) => ask.mockResolvedValue({ object, servedByModel: 'claude-haiku-5-5', durationMs: 900, usage: { totalTokens: 9_000 } } as never);

describe('digestOfRuns: what the runs of a task did', () => {
  const first = () => readJson(RUN.round1, '02-developer.json').data;
  const fix = () => readJson(RUN.round1, '02-developer.attempt-2.json').data;

  it('lists the first run and its round, oldest first', () => {
    const runs = digestOfRuns(RUN.round1, logs);

    expect(runs.map((run) => [run.runId, run.round, run.kind])).toEqual([
      [RUN.round1, 1, 'run'],
      [RUN.round2, 2, 'revision'],
    ]);
    expect(runs[1]!.task).toBe(readJson(RUN.round2, 'run.json').task);
  });

  it('takes the first attempt as the work and the later ones as fixes - in the real run, 19 files then 3', () => {
    const [round1] = digestOfRuns(RUN.round1, logs);

    expect(first().changedFiles).toHaveLength(19);
    expect(fix().changedFiles).toHaveLength(3);
    expect(round1!.summary).toBe(first().summary);
    expect(round1!.fixes).toEqual([fix().summary]);
    // Not the last attempt alone: that would say this run changed three files.
    const everything = new Set([...first().changedFiles, ...fix().changedFiles].map((file: { path: string }) => file.path));
    expect(new Set(round1!.files)).toEqual(everything);
    expect(round1!.files.length).toBe(everything.size);
    expect(round1!.followUps).toEqual(first().followUps);
  });

  it('leaves out the triage of the comments and the squash-message draft', () => {
    const ids = digestOfRuns(RUN.round1, logs).map((run) => run.runId);

    expect(ids).not.toContain(RUN.prTriage);
    expect(ids).not.toContain(RUN.mergeSummary);
    expect(digestOfRuns(RUN.prTriage, logs)).toEqual([]);
  });

  it('is empty for a task with no runs and for a log directory that is not there', () => {
    expect(digestOfRuns('no-such-run', logs)).toEqual([]);
    expect(digestOfRuns(RUN.round1, path.join(logs, 'missing'))).toEqual([]);
  });

  it('still lists a run whose developer artifact cannot be read', () => {
    fs.writeFileSync(path.join(logs, RUN.round1, '02-developer.json'), '{ not json', 'utf8');

    const [round1] = digestOfRuns(RUN.round1, logs);
    expect(round1).toMatchObject({ runId: RUN.round1, summary: '' });
  });
});

describe('buildReconcilePrompt', () => {
  async function inputOf(): Promise<ReconcileInput> {
    const initiative = await mergedProject();
    const key = pullRequestKey(REPO, 8);
    await withStore((store) =>
      store.recordScopeDecision({ prKey: key, commentId: 'c1', initiativeId: initiative.id, fromPhaseId: 'i0001-p1', targetPhaseId: 'i0001-p3', decision: 'DEFER', excerpt: 'Migrate the settings screen too' }),
    );
    await withStore((store) => store.addBacklog(initiative.id, [{ source: 'review', text: 'The chart legend overflows on mobile' }]));
    return await withStore(async (store) => ({
      initiative: (await store.getInitiative(initiative.id))!,
      merged: (await store.getPhase('i0001-p1'))!,
      runs: digestOfRuns(RUN.round1, logs),
      pullRequest: { title: 'Redesign foundation: tokens and primitives', summary: 'Adds the design tokens.' },
      decisions: await store.listScopeDecisions(key),
      backlog: await store.listBacklog(initiative.id),
    }));
  }

  it('gives the agent the phase as planned, what each run really did, and the phases still to come', async () => {
    const { prompt, remaining } = buildReconcilePrompt(await inputOf());

    expect(remaining.map((phase) => phase.id)).toEqual(['i0001-p2', 'i0001-p3', 'i0001-p4']);
    expect(prompt).toContain('Phase 1 of 4 was just merged');
    // The plan, and the roadmap's later phases with their ids to answer by.
    expect(prompt).toContain('### i0001-p1 - 1. Foundation');
    expect(prompt).toContain('### i0001-p2 - 2. Privacy mode');
    expect(prompt).toContain('Mask every amount when privacy mode is on');
    expect(prompt).toContain('No amount is readable in privacy mode');
    // What happened: the work, the fix, the round and what it was asked.
    const developer = readJson(RUN.round1, '02-developer.json').data.summary as string;
    expect(prompt).toContain(flat(developer).slice(0, 80));
    expect(prompt).toContain('Then, sent back by QA or review, it fixed: Fixed the privacy leak in the Profit KPI');
    expect(prompt).toContain('### Round 2');
    expect(prompt).toContain('Asked: In the ui/ app (Astro + React + Tailwind) finish the dark-mode work');
    // Context the agent must not re-propose.
    expect(prompt).toContain('Redesign foundation: tokens and primitives');
    expect(prompt).toContain('deferred to i0001-p3: Migrate the settings screen too');
    expect(prompt).toContain('The chart legend overflows on mobile');
  });

  it('does not list the merged phase among the ones to reconcile', async () => {
    const { prompt } = buildReconcilePrompt(await inputOf());
    const remainingPart = prompt.slice(prompt.indexOf('The remaining phases'));

    expect(remainingPart).not.toContain('i0001-p1');
  });

  it('says there is nothing to answer when no phase remains', async () => {
    const input = await inputOf();
    const finished = { ...input, initiative: { ...input.initiative, phases: input.initiative.phases.map((phase) => ({ ...phase, status: 'MERGED' as const })) } };

    const { prompt, remaining } = buildReconcilePrompt(finished);
    expect(remaining).toEqual([]);
    expect(prompt).toContain('No phase remains: leave `phases` empty.');
  });
});

describe('applyReconcile: the answer goes into the roadmap', () => {
  async function apply(result: PhaseReconcile) {
    const initiative = await mergedProject();
    return await withStore(async (store) => {
      const report = await applyReconcile(store, initiative, initiative.phases[0]!, result);
      return { report, after: (await store.getInitiative(initiative.id))! };
    });
  }
  const phase = (after: Awaited<ReturnType<typeof apply>>['after'], ordinal: number) => after.phases.find((candidate) => candidate.ordinal === ordinal)!;

  it('records what the merged phase delivered', async () => {
    const { after } = await apply(answer());

    expect(phase(after, 1).summary).toBe('Foundation delivered, and round 2 also wired privacy masking into the investment page.');
  });

  it('skips a phase that was already delivered, keeps it in the roadmap, and says why', async () => {
    const { report, after } = await apply(
      answer({ phases: [{ phaseId: 'i0001-p2', status: 'DONE', note: 'Round 2 added usePrivacyMode and masked every amount.', remainingScope: [] }] }),
    );

    expect(phase(after, 2).status).toBe('SKIPPED');
    expect(phase(after, 2).notes.at(-1)).toMatchObject({ source: 'reconciler', text: 'Already delivered - Round 2 added usePrivacyMode and masked every amount.' });
    expect(report.changes).toEqual([{ phaseId: 'i0001-p2', ordinal: 2, status: 'DONE', note: 'Round 2 added usePrivacyMode and masked every amount.' }]);
  });

  it('narrows a phase that was partly delivered to what is left, keeping its goal', async () => {
    const { after } = await apply(
      answer({ phases: [{ phaseId: 'i0001-p2', status: 'PARTIAL', note: 'Masking exists; the header toggle does not.', remainingScope: ['A toggle in the header'] }] }),
    );

    expect(phase(after, 2)).toMatchObject({ status: 'PLANNED', goal: 'Hide amounts on request', scope: ['A toggle in the header'], acceptance: ['No amount is readable in privacy mode'] });
    expect(phase(after, 2).notes.at(-1)!.text).toBe('Masking exists; the header toggle does not.');
  });

  it('keeps the scope when a partial answer names nothing that is left', async () => {
    const { after } = await apply(answer({ phases: [{ phaseId: 'i0001-p2', status: 'PARTIAL', note: 'Some of it.', remainingScope: [] }] }));

    expect(phase(after, 2).scope).toEqual(['Mask every amount when privacy mode is on', 'A toggle in the header']);
  });

  it('ignores what it cannot check: unchanged phases, ids it was not given, a phase that is not waiting', async () => {
    const { report, after } = await apply(
      answer({
        phases: [
          { phaseId: 'i0001-p3', status: 'UNCHANGED', note: '', remainingScope: [] },
          { phaseId: 'i0001-p9', status: 'DONE', note: 'invented', remainingScope: [] },
          { phaseId: 'i0001-p1', status: 'DONE', note: 'the merged phase itself', remainingScope: [] },
        ],
      }),
    );

    expect(report.changes).toEqual([]);
    expect(after.phases.map((candidate) => candidate.status)).toEqual(['MERGED', 'PLANNED', 'PLANNED', 'PLANNED']);
    expect(phase(after, 3).notes).toEqual([]);
  });

  it('keeps the loose ends, once, and only points at a phase that is still to come', async () => {
    const initiative = await mergedProject();
    await withStore((store) => store.addBacklog(initiative.id, [{ source: 'review', text: 'The chart legend overflows on mobile' }]));

    const { report, after } = await withStore(async (store) => {
      const result = await applyReconcile(
        store,
        initiative,
        initiative.phases[0]!,
        answer({
          backlog: [
            { text: 'The chart legend overflows on mobile', severity: 'MINOR', suggestedPhaseId: null },
            { text: 'Header toggle has no keyboard shortcut', severity: 'INFO', suggestedPhaseId: 'i0001-p2' },
            { text: 'Old theme file is unused', severity: 'MINOR', suggestedPhaseId: 'i0001-p1' },
          ],
        }),
      );
      return { report: result, after: await store.listBacklog(initiative.id) };
    });

    expect(report.backlogAdded).toBe(2);
    expect(after.map((item) => [item.text, item.source, item.suggestedPhaseId])).toEqual([
      ['The chart legend overflows on mobile', 'review', null],
      ['Header toggle has no keyboard shortcut', 'reconciler', 'i0001-p2'],
      ['Old theme file is unused', 'reconciler', null],
    ]);
  });

  it('closes the initiative when it skips the last phase that was waiting', async () => {
    const initiative = await mergedProject();
    const { after } = await withStore(async (store) => {
      for (const id of ['i0001-p3', 'i0001-p4']) await store.updatePhase(id, { status: 'SKIPPED' });
      await applyReconcile(store, (await store.getInitiative(initiative.id))!, initiative.phases[0]!, answer({ phases: [{ phaseId: 'i0001-p2', status: 'DONE', note: 'All of it.', remainingScope: [] }] }));
      return { after: (await store.getInitiative(initiative.id))! };
    });

    expect(after.status).toBe('DONE');
  });

  it('does not close it while a phase is still waiting', async () => {
    const { after } = await apply(answer({ phases: [{ phaseId: 'i0001-p2', status: 'DONE', note: 'All of it.', remainingScope: [] }] }));

    expect(after.status).toBe('ACTIVE');
  });

  it('never stores an empty summary: it is also what says the phase was reconciled', async () => {
    const { after } = await apply(answer({ summary: '   ' }));

    expect(phase(after, 1).summary).toBe('Delivered.');
  });
});

describe('reconcilePhase: the whole thing, with the model mocked', () => {
  const planned = async () => (await withStore((store) => store.getInitiative('i0001')))!.phases;

  it('asks the agent once, gives it the real digest, and applies the answer', async () => {
    await mergedProject();
    reply(answer({ phases: [{ phaseId: 'i0001-p2', status: 'DONE', note: 'Round 2 did it.', remainingScope: [] }] }));

    const report = await reconcilePhase({ phaseId: 'i0001-p1' });

    expect(report).toMatchObject({ source: 'agent', changes: [{ phaseId: 'i0001-p2', status: 'DONE' }] });
    expect(ask).toHaveBeenCalledTimes(1);
    const call = ask.mock.calls[0]![0] as { role: string; prompt: string; repoPath: string; step: string };
    expect(call).toMatchObject({ role: 'phase-reconciler', step: 'phase-reconcile', repoPath: REPO });
    expect(call.prompt).toContain('### Round 2');
    expect((await planned())[1]!.status).toBe('SKIPPED');
  });

  it('keeps its trace apart from the runs the user sees: an artifact, and no run record', async () => {
    await mergedProject();
    reply(answer());
    const before = new Set(fs.readdirSync(logs));

    await reconcilePhase({ phaseId: 'i0001-p1' });

    const made = fs.readdirSync(logs).filter((name) => !before.has(name));
    expect(made).toHaveLength(1);
    expect(made[0]).toContain('invest-track-reconcile-1');
    expect(fs.existsSync(path.join(logs, made[0]!, 'run.json'))).toBe(false);
    const artifact = JSON.parse(fs.readFileSync(path.join(logs, made[0]!, '13-phase-reconcile.json'), 'utf8'));
    expect(artifact).toMatchObject({ step: 'phase-reconcile', model: 'claude-haiku-5-5', data: { summary: expect.stringContaining('Foundation delivered') } });
  });

  it('does nothing for a phase that is not merged', async () => {
    await mergedProject();
    await withStore((store) => store.updatePhase('i0001-p1', { status: 'IN_REVIEW' }));

    expect(await reconcilePhase({ phaseId: 'i0001-p1' })).toBeNull();
    expect(await reconcilePhase({ phaseId: 'i0001-p9' })).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it('does not ask again for a phase it already reconciled - unless it is told to', async () => {
    await mergedProject();
    reply(answer());

    await reconcilePhase({ phaseId: 'i0001-p1' });
    expect(await reconcilePhase({ phaseId: 'i0001-p1' })).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);

    await reconcilePhase({ phaseId: 'i0001-p1', force: true });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('spares the call when no phase is left to plan, and records what the developer said', async () => {
    await mergedProject();
    await withStore(async (store) => {
      for (const id of ['i0001-p2', 'i0001-p3', 'i0001-p4']) await store.updatePhase(id, { status: 'SKIPPED' });
    });

    const report = await reconcilePhase({ phaseId: 'i0001-p1' });

    expect(ask).not.toHaveBeenCalled();
    expect(report).toMatchObject({ source: 'none', note: 'No phase is left to plan.' });
    expect((await planned())[0]!.summary).toBe(flat(readJson(RUN.round1, '02-developer.json').data.summary).slice(0, 1_000));
  });

  it('when the agent cannot answer, the phase is still delivered, the roadmap is as written, and the user is told', async () => {
    await mergedProject();
    ask.mockRejectedValue(new Error('OAuth session expired and could not be refreshed. Run `claude login`.'));

    const report = await reconcilePhase({ phaseId: 'i0001-p1' });

    expect(report!.source).toBe('none');
    expect(report!.note).toContain('The AI could not compare the roadmap with what was delivered');
    expect(report!.changes).toEqual([]);
    const phases = await planned();
    expect(phases.map((phase) => phase.status)).toEqual(['MERGED', 'PLANNED', 'PLANNED', 'PLANNED']);
    expect(phases[1]!.scope).toEqual(['Mask every amount when privacy mode is on', 'A toggle in the header']);
  });

  it('...and it stays uncompared, with the reason kept on the phase - so it can be asked for again', async () => {
    await mergedProject();
    ask.mockRejectedValue(new Error('OAuth session expired and could not be refreshed. Run `claude login`.'));

    await reconcilePhase({ phaseId: 'i0001-p1' });

    const [merged] = await planned();
    expect(merged!.summary).toBeNull(); // the summary is what says "compared": it is not claimed
    expect(merged!.notes.at(-1)).toMatchObject({ source: 'factory', text: expect.stringContaining('The AI could not compare the roadmap') });
    expect(merged!.notes.at(-1)!.text).toContain('run `claude login` in a terminal'); // the reason, in the user\'s words
  });

  it('...so that asking again, without --force, really asks - and once it works the phase is compared', async () => {
    await mergedProject();
    ask.mockRejectedValueOnce(new Error('network down'));
    await reconcilePhase({ phaseId: 'i0001-p1' });
    expect(ask).toHaveBeenCalledTimes(1);

    reply(answer());
    const again = await reconcilePhase({ phaseId: 'i0001-p1' });

    expect(ask).toHaveBeenCalledTimes(2);
    expect(again).toMatchObject({ source: 'agent' });
    expect((await planned())[0]!.summary).toContain('Foundation delivered');
    // ...and now it is done: a third look does not ask.
    expect(await reconcilePhase({ phaseId: 'i0001-p1' })).toBeNull();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('puts nothing from a rehearsal into the roadmap', async () => {
    await mergedProject();
    ask.mockResolvedValue({ object: answer({ summary: '[dry-run] stand-in', phases: [{ phaseId: 'i0001-p2', status: 'DONE', note: 'stand-in', remainingScope: [] }] }), dryRun: true, servedByModel: 'dry-run', durationMs: 0 } as never);

    const report = await reconcilePhase({ phaseId: 'i0001-p1' });

    expect(report).toMatchObject({ source: 'none', changes: [] });
    const phases = await planned();
    expect(phases[1]!.status).toBe('PLANNED');
    expect(phases[0]!.summary).not.toContain('stand-in');
  });
});
