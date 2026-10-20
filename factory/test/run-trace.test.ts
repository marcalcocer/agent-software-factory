import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN, copyRuns } from '../../fixtures';
import { composeRevision, readTriageSummary } from '../src/cli/revision.ts';
import { createRunTrace, openRunTrace, readEvents, updateRunMeta, type RunTraceMeta } from '../src/tools/logger-tools.ts';

let logs: string;
beforeEach(() => {
  logs = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-run-trace-'));
  vi.stubEnv('FACTORY_LOG_DIR', logs);
});
afterEach(() => {
  fs.rmSync(logs, { recursive: true, force: true });
});

const meta = (over: Partial<RunTraceMeta> = {}): RunTraceMeta => ({
  runId: 'r1',
  task: 'Add pagination',
  repoPath: '/w/repo',
  repoName: 'repo',
  dryRun: false,
  startedAt: '2026-10-19T17:00:05.000Z',
  ...over,
});

const runJson = (runId = 'r1') => JSON.parse(fs.readFileSync(path.join(logs, runId, 'run.json'), 'utf8'));

describe('the run is recorded the moment it is started', () => {
  it('is findable as soon as the CLI has written it, before the workflow runs a step', () => {
    createRunTrace(meta({ kind: 'revision', rootRunId: 'r0', round: 2, title: 'Round two' }));

    expect(runJson()).toMatchObject({ runId: 'r1', kind: 'revision', rootRunId: 'r0', round: 2, title: 'Round two' });
    expect(readEvents('r1').map((e) => e.type)).toEqual(['run_started']);
  });

  it('is completed, not replaced, by the first workflow step', () => {
    // The CLI wrote this at 17:00:00, a few seconds before the step started.
    createRunTrace(meta({ startedAt: '2026-10-19T17:00:00.000Z', title: 'From the request' }));

    const opened = openRunTrace(
      meta({ startedAt: '2026-10-19T17:00:05.000Z', branch: 'factory/f0042/feat-x', models: { developer: 'sonnet' }, taskId: 'f0042' }),
    );

    expect(opened.startedAt).toBe('2026-10-19T17:00:00.000Z'); // the run began when it was started
    expect(runJson()).toMatchObject({
      startedAt: '2026-10-19T17:00:00.000Z',
      branch: 'factory/f0042/feat-x',
      taskId: 'f0042',
      models: { developer: 'sonnet' },
      title: 'From the request', // still there: the step brought no title of its own
    });
    expect(readEvents('r1').filter((e) => e.type === 'run_started')).toHaveLength(1);
  });

  it('creates the record when nothing started the run before it (the API, the smoke test)', () => {
    const opened = openRunTrace(meta());

    expect(opened.startedAt).toBe('2026-10-19T17:00:05.000Z');
    expect(runJson().task).toBe('Add pagination');
    expect(readEvents('r1').filter((e) => e.type === 'run_started')).toHaveLength(1);
  });

  it('keeps what the user and the namer set, when the record is updated later', () => {
    createRunTrace(meta({ title: 'Provisional', titleSource: 'fallback' }));
    updateRunMeta('r1', { title: 'Dark mode for every screen', titleSource: 'agent', branch: 'factory/f0007/feat-dark-mode' });
    updateRunMeta('r1', { title: 'My own name', titleSource: 'user' });

    expect(runJson()).toMatchObject({ title: 'My own name', titleSource: 'user', branch: 'factory/f0007/feat-dark-mode', task: 'Add pagination' });
  });
});

describe('the title of a round comes from its triage', () => {
  const entry = {
    key: '/home/dev/workspace/invest-track#8',
    repoPath: '/home/dev/workspace/invest-track',
    repoName: 'invest-track',
    number: 8,
    url: 'https://github.com/marcalcocer/invest-track/pull/8',
    title: 'PR',
    headBranch: 'factory/i-want-to-do-a-big-refactor-on-t-61e6',
    baseBranch: 'master',
    rootRunId: RUN.round1,
    latestRunId: RUN.round1,
    round: 1,
    watchSince: '2026-10-19T17:25:28.872Z',
    state: 'OPEN' as const,
    handledCommentIds: [],
    registeredAt: '',
    updatedAt: '',
  };

  const withTriage = (roundTitle?: string) => {
    copyRuns(logs, [RUN.round1, RUN.prTriage], (file) => /^(run|summary)\.json$|^\d{2}-.*\.json$/.test(file));
    if (roundTitle !== undefined) {
      const file = path.join(logs, RUN.prTriage, 'summary.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), roundTitle }));
    }
    return readTriageSummary(RUN.prTriage)!;
  };

  it('hands the triage\'s title to the round', () => {
    const triage = withTriage('Finish dark mode on the investment pages');
    const result = composeRevision({ entry, triage });

    expect(triage.roundTitle).toBe('Finish dark mode on the investment pages');
    expect(result.ok && result.revision.title).toBe('Finish dark mode on the investment pages');
  });

  it('leaves the round untitled when the triage named none, for the workflow to name it by its task and number', () => {
    const result = composeRevision({ entry, triage: withTriage() });
    expect(result.ok && result.revision.title).toBeUndefined();
  });
});

describe('a name the user gave is theirs', () => {
  it('is not replaced when the factory names the task afterwards', () => {
    createRunTrace(meta({ title: 'Provisional', titleSource: 'fallback' }));
    updateRunMeta('r1', { title: 'My own name', titleSource: 'user' });

    // The namer answers a few seconds later.
    updateRunMeta('r1', { title: 'Dark mode for every screen', titleSource: 'agent', branch: 'factory/f0007/feat-dark-mode' });

    expect(runJson()).toMatchObject({ title: 'My own name', titleSource: 'user', branch: 'factory/f0007/feat-dark-mode' });
  });

  it('is not replaced when the workflow completes the record the CLI made', () => {
    createRunTrace(meta({ title: 'Provisional' }));
    updateRunMeta('r1', { title: 'My own name', titleSource: 'user' });

    openRunTrace(meta({ title: 'Provisional again', titleSource: 'fallback', taskId: 'f0007' }));

    expect(runJson()).toMatchObject({ title: 'My own name', titleSource: 'user', taskId: 'f0007' });
  });
});
