import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { backlogFromRun } from '../src/initiatives/harvest.ts';
import { linkToInitiative, loadRoadmapView, renameInitiative, startPhase } from '../src/initiatives/link.ts';
import { withStore } from '../src/initiatives/store.ts';
import { roadmapSection, withRoadmap } from '../src/tools/pr-text.ts';
import type { PolishResult } from '../src/utils/schemas.ts';

const REPO = '/home/dev/workspace/invest-track';
let logs: string;

beforeEach(() => {
  logs = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-link-'));
  vi.stubEnv('FACTORY_LOG_DIR', logs);
});
afterEach(() => fs.rmSync(logs, { recursive: true, force: true }));

/** A project whose phase 1 is in review: the state right after the first pull request is opened. */
async function project() {
  return await withStore(async (store) => {
    const created = await store.createInitiative({ repoPath: REPO, title: 'Redesign', goal: 'big refactor', firstPhase: { title: 'Redesign', goal: 'big refactor' } });
    await store.linkRun(created.phases[0]!.id, { taskId: 'f0042', rootRunId: 'run-1', branch: 'factory/f0042/feat-x' });
    const set = await store.setRoadmap(created.id, { title: 'Redesign the frontend', phases: [{ title: 'Foundation', scope: ['tokens'] }, { title: 'Screens' }, { title: 'Cleanup' }] });
    await store.linkPullRequest(set.phases[0]!.id, { number: 8, url: 'https://github.com/o/r/pull/8' });
    return set;
  });
}

describe('linkToInitiative: a new task', () => {
  const request = { runId: 'r1', repoPath: REPO, task: 'Add pagination to the positions endpoint', provisionalTitle: 'Add pagination' };

  it('files it as a quick initiative of one phase', async () => {
    const link = await linkToInitiative(request);

    expect(link).toMatchObject({ id: 'i0001', phaseId: 'i0001-p1', ordinal: 1, total: 1, title: 'Add pagination', phaseTitle: 'Add pagination', mode: 'new' });
    const stored = await withStore((store) => store.getInitiative('i0001'));
    expect(stored).toMatchObject({ kind: 'quick', goal: request.task });
  });

  it('files a retried run under what its first attempt made, not a second initiative', async () => {
    const first = await linkToInitiative(request);
    const again = await linkToInitiative({ ...request, existing: { phaseId: first!.phaseId } });

    expect(again!.id).toBe(first!.id);
    expect((await withStore((store) => store.listInitiatives(REPO, { includeQuick: true }))).length).toBe(1);
  });

  it('takes the name the namer gave, and starts the phase with its task and branch', async () => {
    const link = (await linkToInitiative(request))!;
    await renameInitiative(link, 'Cursor pagination for positions');
    await startPhase(link, { taskId: 'f0042', rootRunId: 'r1', branch: 'factory/f0042/feat-cursor-pagination' });

    const stored = (await withStore((store) => store.getInitiative(link.id)))!;
    expect(stored.title).toBe('Cursor pagination for positions');
    expect(stored.phases[0]).toMatchObject({ title: 'Cursor pagination for positions', status: 'RUNNING', taskId: 'f0042', branch: 'factory/f0042/feat-cursor-pagination' });
  });
});

describe('linkToInitiative: one phase of a roadmap', () => {
  const phaseRequest = (phaseId: string, runId = 'r2') => ({
    runId, repoPath: REPO, task: 'Phase 2 of 3', provisionalTitle: 'Screens', phase: { initiativeId: 'i0001', phaseId },
  });

  it('is refused while the phase before it is only a pull request, and says which', async () => {
    await project();
    await expect(linkToInitiative(phaseRequest('i0001-p2'))).rejects.toThrow('phase 1 ("Foundation"), which is not merged yet');
  });

  it('starts once the phase before it is merged', async () => {
    await project();
    await withStore((store) => store.markMerged('i0001-p1'));

    const link = await linkToInitiative(phaseRequest('i0001-p2'));
    expect(link).toMatchObject({ id: 'i0001', phaseId: 'i0001-p2', ordinal: 2, total: 3, phaseTitle: 'Screens', title: 'Redesign the frontend', mode: 'phase' });
  });

  it('lets the run that started a phase be retried, but not a second run start it', async () => {
    await project();
    await withStore(async (store) => {
      await store.markMerged('i0001-p1');
      await store.linkRun('i0001-p2', { taskId: 'f0043', rootRunId: 'r2', branch: 'b' });
    });

    expect((await linkToInitiative(phaseRequest('i0001-p2', 'r2')))!.phaseId).toBe('i0001-p2'); // the same run, again
    await expect(linkToInitiative(phaseRequest('i0001-p2', 'r9'))).rejects.toThrow('in progress');
  });

  it('is an error for a phase that does not exist: a run of a phase exists for that phase', async () => {
    await project();
    await expect(linkToInitiative({ ...phaseRequest('i0001-p9') })).rejects.toThrow('was not found');
  });

  it('is an error for another repository\'s phase', async () => {
    await project();
    await expect(linkToInitiative({ ...phaseRequest('i0001-p2'), repoPath: '/elsewhere' })).rejects.toThrow('belongs to');
  });
});

describe('linkToInitiative: a round', () => {
  it('belongs to the phase of the run that opened the pull request, found by its id or by its task', async () => {
    await project();
    const round = { runId: 'r3', repoPath: REPO, task: 'Address the comments', provisionalTitle: 'x' };

    const byPhase = await linkToInitiative({ ...round, roundOf: { phaseId: 'i0001-p1' } });
    const byTask = await linkToInitiative({ ...round, roundOf: { rootTaskId: 'f0042' } });

    expect(byPhase).toMatchObject({ phaseId: 'i0001-p1', mode: 'round', total: 3 });
    expect(byTask!.phaseId).toBe('i0001-p1');
  });

  it('changes nothing about the phase: its pull request is open', async () => {
    await project();
    const link = (await linkToInitiative({ runId: 'r3', repoPath: REPO, task: 't', provisionalTitle: 'x', roundOf: { phaseId: 'i0001-p1' } }))!;

    await startPhase(link, { taskId: 'f0042', rootRunId: 'run-1', branch: 'b' });
    expect((await withStore((store) => store.getPhase('i0001-p1')))!.status).toBe('IN_REVIEW');
  });

  it('is simply not tracked for a pull request from before initiatives existed', async () => {
    expect(await linkToInitiative({ runId: 'r3', repoPath: REPO, task: 't', provisionalTitle: 'x', roundOf: { rootTaskId: 'f0001' } })).toBeUndefined();
  });
});

describe('the roadmap a pull request shows', () => {
  it('has the phases and the one this pull request is, and nothing for a task of one phase', async () => {
    await project();
    const link = (await linkToInitiative({ runId: 'r3', repoPath: REPO, task: 't', provisionalTitle: 'x', roundOf: { phaseId: 'i0001-p1' } }))!;
    expect(await loadRoadmapView(link)).toMatchObject({ title: 'Redesign the frontend', current: 1, total: 3 });

    const quick = (await linkToInitiative({ runId: 'q', repoPath: REPO, task: 'a task', provisionalTitle: 'A task' }))!;
    expect(await loadRoadmapView(quick)).toBeNull();
    expect(await loadRoadmapView(undefined)).toBeNull();
  });

  it('is written for the pull request: checked boxes for what is delivered and for this one, open for what is left', async () => {
    await project();
    await withStore((store) => store.markMerged('i0001-p1'));
    const link = (await linkToInitiative({ runId: 'r2', repoPath: REPO, task: 't', provisionalTitle: 'Screens', phase: { initiativeId: 'i0001', phaseId: 'i0001-p2' } }))!;
    const view = (await loadRoadmapView(link))!;

    expect(roadmapSection(view)).toBe(
      [
        '## Roadmap',
        '',
        'This pull request is **phase 2 of 3** of "Redesign the frontend".',
        '',
        '- [x] 1. Foundation - merged',
        '- [x] 2. Screens - **this pull request**',
        '- [ ] 3. Cleanup',
        '',
        'Not in this pull request: phase 3.',
      ].join('\n'),
    );
  });

  it('goes before the quality gates, replaces one a model wrote, and is absent for a task of one phase', () => {
    const view = { title: 'T', current: 1, total: 2, phases: [{ ordinal: 1, title: 'A', status: 'IN_REVIEW' as const }, { ordinal: 2, title: 'B', status: 'PLANNED' as const }] };
    const body = '## Summary\nS\n\n## Roadmap\nmodel text\n\n## Quality gates\n- QA: PASS\n\n## Follow-ups\n- x';

    const result = withRoadmap(body, view);
    expect(result.indexOf('## Roadmap')).toBeLessThan(result.indexOf('## Quality gates'));
    expect(result).not.toContain('model text');
    expect(result.match(/## Roadmap/g)).toHaveLength(1);
    expect(withRoadmap('## Summary\nS', null)).toBe('## Summary\nS');
    expect(withRoadmap('## Summary\nS', view)).toBe(`## Summary\nS\n\n${roadmapSection(view)}`);
  });
});

describe('backlogFromRun: what a finished run leaves for later', () => {
  const polish = (over: Partial<PolishResult>): PolishResult => ({
    status: 'APPLIED', candidates: [], applied: [], declined: [], unanswered: [], reported: [], changedFiles: [], changedLines: 0, ...over,
  });
  const candidate = (id: string, problem: string, over: Record<string, unknown> = {}) => ({
    id, source: 'review' as const, severity: 'MINOR', file: 'ui/src/Summary.jsx', line: 57, problem, fix: 'Do it.', ...over,
  });

  it('keeps the findings that were not fixed, with where, the fix suggested and why they were not fixed', () => {
    const items = backlogFromRun({
      polish: polish({
        candidates: [candidate('REV-1', 'Sign colour leaks'), candidate('REV-2', 'var and const are mixed', { file: 'ui/src/theme.js', line: 1 })],
        applied: ['REV-1'],
        declined: [{ id: 'REV-2', reason: 'the rule is written for Java' }],
      }),
    });

    expect(items).toEqual([
      { source: 'review', text: 'ui/src/theme.js:1: var and const are mixed', severity: 'MINOR', evidence: 'Suggested: Do it. Not fixed: the rule is written for Java' },
    ]);
  });

  it('keeps everything when the polish was undone, switched off, or never ran; nothing it fixed', () => {
    const all = [candidate('REV-1', 'A'), candidate('REV-2', 'B')];
    expect(backlogFromRun({ polish: polish({ status: 'REVERTED', candidates: all, applied: [] }) })).toHaveLength(2);
    expect(backlogFromRun({ polish: polish({ status: 'SKIPPED', candidates: all }) })).toHaveLength(2);
    expect(backlogFromRun({ polish: polish({ status: 'APPLIED', candidates: all, applied: ['REV-1', 'REV-2'] }) })).toHaveLength(0);
    expect(backlogFromRun({ polish: null })).toEqual([]);
  });

  it('keeps what was only reported - the pre-existing XSS of the real run - but not nits', () => {
    const items = backlogFromRun({
      polish: polish({
        status: 'NONE',
        reported: [
          { source: 'security', summary: 'XSS in ui/src/lib/ChartUtils.js:37: self-XSS', reason: 'informational' },
          { source: 'review', summary: 'naming', reason: 'a nit' },
        ],
      }),
    });
    expect(items).toEqual([{ source: 'security', text: 'XSS in ui/src/lib/ChartUtils.js:37: self-XSS', severity: 'INFO', evidence: 'informational' }]);
  });

  it('keeps the follow-ups the developer and the documentation named, but not its answers to the polish findings', () => {
    const items = backlogFromRun({
      polish: null,
      developerFollowUps: ['Dark mode of the chart toolbar is still open', 'REV-2: Not applied - style only'],
      documentationFollowUps: ['  No CHANGELOG exists;  decide whether to add one '],
    });
    expect(items.map((i) => [i.source, i.text])).toEqual([
      ['developer', 'Dark mode of the chart toolbar is still open'],
      ['documentation', 'No CHANGELOG exists; decide whether to add one'],
    ]);
  });
});
