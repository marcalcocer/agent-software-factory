import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN, copyRuns, readJson } from '../../fixtures';
import { composeRevision, findLatestTriage, latestRunInChain, readTriageSummary } from '../src/cli/revision.ts';
import type { RegisteredPullRequest } from '../src/tools/pr-registry.ts';

const jsonOnly = (file: string) => file === 'run.json' || file === 'summary.json' || /^\d{2}-.*\.json$/.test(file);

/** The registry entry of pull request #8 as it stood after round 1 delivered. */
const afterRound1 = (over: Partial<RegisteredPullRequest> = {}): RegisteredPullRequest => ({
  key: '/home/dev/workspace/invest-track#8',
  repoPath: '/home/dev/workspace/invest-track',
  repoName: 'invest-track',
  number: 8,
  url: 'https://github.com/marcalcocer/invest-track/pull/8',
  title: 'feat(ui): add design tokens, dark mode and modern app shell',
  headBranch: 'factory/i-want-to-do-a-big-refactor-on-t-61e6',
  baseBranch: 'master',
  rootRunId: RUN.round1,
  latestRunId: RUN.round1,
  round: 1,
  watchSince: '2026-10-19T17:25:28.872Z',
  state: 'OPEN',
  handledCommentIds: [],
  registeredAt: '2026-10-19T17:25:28.872Z',
  updatedAt: '2026-10-19T17:25:28.872Z',
  ...over,
});

describe('a further round, replayed from the real run that started it', () => {
  let logs: string;

  beforeEach(() => {
    logs = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-revision-'));
    vi.stubEnv('FACTORY_LOG_DIR', logs);
  });
  afterEach(() => {
    fs.rmSync(logs, { recursive: true, force: true });
  });

  /** The state of the logs when the user's comments arrived: round 1 and the triage, nothing else. */
  const beforeRound2 = () => copyRuns(logs, [RUN.round1, RUN.prTriage], jsonOnly);

  it('reads the triage of the comments', () => {
    beforeRound2();
    const triage = readTriageSummary(RUN.prTriage)!;

    expect(triage).toMatchObject({ pullRequest: 8, status: 'RERUN_IMPLEMENTATION', branch: 'factory/i-want-to-do-a-big-refactor-on-t-61e6' });
    expect(triage.comments.map((c) => c.category)).toEqual(['CODE_CHANGE_REQUEST', 'QUESTION']);
    expect(findLatestTriage('/home/dev/workspace/invest-track', 8)?.runId).toBe(RUN.prTriage);
    expect(findLatestTriage('/home/dev/workspace/invest-track', 9)).toBeNull();
  });

  it('builds the same round the factory really ran', () => {
    beforeRound2();
    const result = composeRevision({ entry: afterRound1(), triage: readTriageSummary(RUN.prTriage)! });
    if (!result.ok) throw new Error(result.reason);

    const actual = readJson(RUN.round2, 'run.json'); // what round 2 recorded about itself
    expect(result.revision).toMatchObject({
      round: actual.round,
      parentRunId: actual.parentRunId,
      rootRunId: actual.rootRunId,
      action: 'RERUN_IMPLEMENTATION',
    });
    expect(result.revision.pullRequest).toMatchObject({ number: actual.pullRequest.number, headBranch: actual.branch });
    expect(result.revision.comments).toHaveLength(2);
    expect(result.revision.originalTask).toBe(readJson(RUN.round1, 'run.json').task);
    expect(result.pipeline).toEqual(readJson(RUN.round1, 'run.json').pipeline);
    expect(result.task).toBe(readTriageSummary(RUN.prTriage)!.followUpTask.trim());
  });

  it('continues from the latest round of the task, not from the registry alone', () => {
    // Round 2 ran (and may not have pushed): the registry still says round 1, the next round is 3.
    copyRuns(logs, [RUN.round1, RUN.round2, RUN.prTriage], jsonOnly);

    expect(latestRunInChain(RUN.round1)).toEqual({ runId: RUN.round2, round: 2 });
    const result = composeRevision({ entry: afterRound1(), triage: readTriageSummary(RUN.prTriage)! });
    if (!result.ok) throw new Error(result.reason);
    expect(result.revision).toMatchObject({ round: 3, parentRunId: RUN.round2, rootRunId: RUN.round1 });
  });

  it('does not count the triage runs as rounds', () => {
    beforeRound2();
    expect(latestRunInChain(RUN.round1)).toEqual({ runId: RUN.round1, round: 1 });
  });

  it('leaves out the comments that were handled in the meantime', () => {
    beforeRound2();
    const triage = readTriageSummary(RUN.prTriage)!;
    const [first] = triage.comments;

    const some = composeRevision({ entry: afterRound1({ handledCommentIds: [first!.id] }), triage });
    if (!some.ok) throw new Error(some.reason);
    expect(some.revision.comments.map((c) => c.id)).not.toContain(first!.id);

    const all = composeRevision({ entry: afterRound1({ handledCommentIds: triage.comments.map((c) => c.id) }), triage });
    expect(all).toEqual({ ok: false, reason: 'Every review comment of this triage has already been handled.' });
  });

  it('refuses a triage that does not call for code, unless the human decides otherwise', () => {
    beforeRound2();
    const triage = { ...readTriageSummary(RUN.prTriage)!, status: 'REPLY_ONLY' };

    const refused = composeRevision({ entry: afterRound1(), triage });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain('does not call for code changes');

    const forced = composeRevision({ entry: afterRound1(), triage, action: 'RERUN_PLANNING' });
    expect(forced.ok && forced.revision.action).toBe('RERUN_PLANNING');
  });

  it('gives a task even if the triage wrote none', () => {
    beforeRound2();
    const triage = { ...readTriageSummary(RUN.prTriage)!, followUpTask: '  ' };
    const result = composeRevision({ entry: afterRound1(), triage });
    expect(result.ok && result.task).toBe('Address the review comments on pull request #8.');
  });
});
