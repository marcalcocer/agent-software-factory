import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RUN, copyRuns, readEvents, runDir } from '../../fixtures';
import { readRunArtifacts, readRunEvents, readRunState, renameRun } from '../electron/services/run-state';

const stateOf = (runId: string, alive = false) => readRunState(runDir(runId), runId, alive);

describe('readRunState on real runs', () => {
  it('reads a delivered first round', () => {
    const state = stateOf(RUN.round1)!;

    expect(state.repoPath).toBe('/home/dev/workspace/invest-track');
    expect(state.run).toMatchObject({
      runId: RUN.round1,
      repoId: 'invest-track',
      status: 'DELIVERED',
      attempts: 2,
      branch: 'factory/i-want-to-do-a-big-refactor-on-t-61e6',
      kind: 'run',
      round: 1,
      rootRunId: RUN.round1,
      finishedAt: '2026-10-19T17:25:28.891Z',
    });
    expect(state.run.pipeline).toEqual({ qa: true, review: true, security: true, documentation: true });
    expect(state.run.tokens?.total).toBe(1_502_782);
    expect(state.run.parentRunId).toBeUndefined();
    expect(state.run.pullRequest).toBeUndefined();
  });

  it('knows a second round continues the first one on the same pull request', () => {
    const { run } = stateOf(RUN.round2)!;

    expect(run).toMatchObject({
      kind: 'revision',
      round: 2,
      rootRunId: RUN.round1,
      parentRunId: RUN.round1,
      branch: 'factory/i-want-to-do-a-big-refactor-on-t-61e6',
    });
    expect(run.pullRequest).toMatchObject({ number: 8, baseBranch: 'master' });
  });

  it('marks the triage of review comments as plumbing, not as a task', () => {
    expect(stateOf(RUN.prTriage)!.run.kind).toBe('pr-feedback');
  });

  it('does not take a directory without a run record for a run', () => {
    // The squash-message draft leaves an artifact and events, but neither run.json nor summary.json.
    expect(stateOf(RUN.mergeSummary)).toBeNull();
  });

  it('reports the reason a run was rejected at the door', () => {
    const { run } = stateOf(RUN.failedValidation)!;
    expect(run.status).toBe('FAILED');
    expect(run.error).toContain('Invalid input data');
    expect(run.finishedAt).toBeDefined();
  });

  it('reads an escalated dry run', () => {
    expect(stateOf(RUN.smokeEscalated)!.run.status).toBe('ESCALATED_TO_HUMAN');
  });

  it('lets a live process beat whatever the previous attempt recorded', () => {
    // A retry must not look finished (or failed) because of the summary the last attempt left.
    const { run } = stateOf(RUN.round1, true)!;
    expect(run.status).toBe('RUNNING');
    expect(run.finishedAt).toBeUndefined();
  });
});

describe('readRunState on runs that stopped in the middle', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-run-state-'));
  });
  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** Round 1 as it was after its first `lines` events, with no outcome recorded yet. */
  const cutShort = (lines: number): string => {
    copyRuns(scratch, [RUN.round1], (file) => file === 'run.json');
    const events = fs.readFileSync(path.join(runDir(RUN.round1), 'events.ndjson'), 'utf8').split('\n');
    fs.writeFileSync(path.join(scratch, RUN.round1, 'events.ndjson'), `${events.slice(0, lines).join('\n')}\n`);
    return path.join(scratch, RUN.round1);
  };

  it('shows a run waiting at a gate as suspended, and not as finished', () => {
    const dir = cutShort(5);
    fs.writeFileSync(
      path.join(dir, 'pending-input.json'),
      JSON.stringify({ reason: 'CLARIFICATION_REQUIRED', runId: RUN.round1, step: 'plan', questions: ['Q1?'] }),
    );

    const state = readRunState(dir, RUN.round1, false)!;
    expect(state.run.status).toBe('SUSPENDED');
    expect(state.run.finishedAt).toBeUndefined();
  });

  it('explains where a run stopped when it recorded no outcome', () => {
    const state = readRunState(cutShort(10), RUN.round1, false)!;

    expect(state.run.status).toBe('FAILED');
    expect(state.run.error).toContain('stopped right after the Developer step');
  });

  it('explains a run that died after its gate was answered', () => {
    const state = readRunState(cutShort(5), RUN.round1, false)!;

    expect(state.run.status).toBe('FAILED');
    expect(state.run.error).toContain("architect's questions");
    expect(state.run.failedStep).toBe('plan');
  });

  it('prefers the reason the process recorded as it died', () => {
    const dir = cutShort(10);
    fs.writeFileSync(
      path.join(dir, 'failure.json'),
      JSON.stringify({ at: '2026-10-19T17:20:00.000Z', exitCode: 1, message: 'claude is not signed in' }),
    );

    const { run } = readRunState(dir, RUN.round1, false)!;
    expect(run.error).toBe('claude is not signed in');
    expect(run.finishedAt).toBe('2026-10-19T17:20:00.000Z');
  });
});

describe('readRunArtifacts / readRunEvents', () => {
  it('lists the artifacts of a run in order, attempts included', () => {
    const artifacts = readRunArtifacts(runDir(RUN.round1));

    expect(artifacts.map((a) => `${a.step}#${a.attempt}`)).toEqual([
      'pm-architect#1',
      'developer#2',
      'developer#1',
      'qa-tester#2',
      'qa-tester#1',
      'triage#1',
      'code-review#2',
      'security#2',
      'documentation#2',
      'pr-writer#2',
      'delivery#1',
    ]);
    expect(artifacts.find((a) => a.step === 'qa-tester' && a.attempt === 1)?.status).toBe('FAIL');
    expect(artifacts.find((a) => a.step === 'delivery')?.status).toBe('PR_CREATED');
  });

  it('returns nothing for a directory that does not exist', () => {
    expect(readRunArtifacts(path.join(os.tmpdir(), 'no-such-run-directory'))).toEqual([]);
  });

  it('skips an artifact that is torn while being written', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-artifacts-'));
    try {
      fs.writeFileSync(path.join(dir, '01-pm-architect.json'), '{"step":"pm-architect","status":"COMP');
      fs.writeFileSync(path.join(dir, '02-developer.json'), JSON.stringify({ step: 'developer', status: 'COMPLETED' }));

      const artifacts = readRunArtifacts(dir);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({ step: 'developer', attempt: 1, data: {} });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads every event of a run and ignores a torn last line', () => {
    const events = readRunEvents(runDir(RUN.round1));
    expect(events).toHaveLength(readEvents(RUN.round1).length);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-events-'));
    try {
      fs.writeFileSync(path.join(dir, 'events.ndjson'), '{"at":"t","type":"run_started"}\n{"at":"t","type":"agent_c');
      expect(readRunEvents(dir).map((e) => e.type)).toEqual(['run_started']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the title of a run', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-titles-'));
  });
  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const withTitle = (meta: Record<string, unknown>, summary?: Record<string, unknown>) => {
    copyRuns(scratch, [RUN.round1], (file) => file === 'run.json' || (summary !== undefined && file === 'summary.json'));
    const dir = path.join(scratch, RUN.round1);
    const runJson = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ ...runJson, ...meta }));
    if (summary) {
      const summaryJson = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
      fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ ...summaryJson, ...summary }));
    }
    return dir;
  };

  it('comes from the run itself, with its task id', () => {
    const dir = withTitle({ title: 'Dark mode for every screen', titleSource: 'agent', taskId: 'f0042' });
    expect(readRunState(dir, RUN.round1, true)!.run).toMatchObject({
      title: 'Dark mode for every screen',
      titleSource: 'agent',
      taskId: 'f0042',
    });
  });

  it('is the one in run.json, because that is where a rename is written', () => {
    const dir = withTitle({ title: 'My own name', titleSource: 'user' }, { title: 'Name from the end of the run' });
    expect(readRunState(dir, RUN.round1, false)!.run.title).toBe('My own name');
  });

  it('falls back to the summary for a run whose record has none', () => {
    const dir = withTitle({}, { title: 'Name from the end of the run' });
    expect(readRunState(dir, RUN.round1, false)!.run.title).toBe('Name from the end of the run');
  });

  it('is absent on runs from before titles were stored, not invented', () => {
    expect(stateOf(RUN.round1)!.run.title).toBeUndefined();
    expect(stateOf(RUN.round1)!.run.taskId).toBeUndefined();
  });

  it('survives a rename, which is written to run.json and marked as the user\'s', () => {
    const dir = withTitle({ title: 'Dark mode for every screen', titleSource: 'agent' });
    renameRun(dir, 'Phase one: tokens and dark mode');

    expect(readRunState(dir, RUN.round1, false)!.run).toMatchObject({
      title: 'Phase one: tokens and dark mode',
      titleSource: 'user',
    });
    // Nothing else about the run changed.
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')).task).toBe(stateOf(RUN.round1)!.run.task);
  });

  it('cannot rename a directory that is not a run', () => {
    expect(() => renameRun(scratch, 'x')).toThrow('no record to rename');
  });
});
