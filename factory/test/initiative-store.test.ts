import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SCHEMA_VERSION, fingerprintOf, openStore, withStore, type InitiativeStore } from '../src/initiatives/store.ts';

const REPO = '/home/dev/workspace/invest-track';
const TSX = path.resolve(import.meta.dirname, '../../node_modules/.bin/tsx');
const WORKER = path.resolve(import.meta.dirname, 'support/store-worker.mts');

/** A factory process of its own that creates `count` initiatives and prints their ids. */
function runWorker(dbFile: string, worker: number, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('node', [TSX, WORKER, dbFile, String(worker), String(count)], { env: { ...process.env, FACTORY_LOG_DIR: path.dirname(dbFile) } }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`));
      else resolve(stdout.trim().split('\n').filter(Boolean));
    });
  });
}

let dir: string;
let file: string;
let store: InitiativeStore;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-initiatives-'));
  file = path.join(dir, 'initiatives.db');
  store = await openStore(file);
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The UI refactor as the architect would have phased it. */
const uiRefactor = {
  title: 'Professional redesign of the frontend',
  phases: [
    { title: 'Design tokens, dark mode and app shell', goal: 'The foundation', scope: ['tokens', 'theme toggle', 'header'], acceptance: ['build passes'] },
    { title: 'Investment pages and modals', goal: 'Apply it to the detail screens', scope: ['details', 'modals'] },
    { title: 'Accessibility and cleanup', scope: ['aria', 'focus'], dependsOnOrdinals: [2] },
  ],
};

async function projectWithPhaseRunning() {
  const created = await store.createInitiative({
    repoPath: REPO,
    title: 'Redesign the frontend',
    goal: 'I want to do a big refactor on the UI',
    firstPhase: { title: 'Redesign the frontend', goal: 'I want to do a big refactor on the UI', status: 'RUNNING' },
  });
  await store.linkRun(created.phases[0]!.id, { taskId: 'f0042', rootRunId: 'run-1', branch: 'factory/f0042/feat-x' });
  return await store.setRoadmap(created.id, uiRefactor);
}

describe('creating an initiative', () => {
  it('numbers initiatives and phases in order, and starts as a quick task with one phase', async () => {
    const first = await store.createInitiative({ repoPath: REPO, title: 'A', goal: 'a', firstPhase: { title: 'A' } });
    const second = await store.createInitiative({ repoPath: REPO, title: 'B', goal: 'b', firstPhase: { title: 'B' } });

    expect([first.id, second.id]).toEqual(['i0001', 'i0002']);
    expect(first).toMatchObject({ kind: 'quick', status: 'ACTIVE', repoName: 'invest-track', backlogOpen: 0 });
    expect(first.phases.map((phase) => [phase.id, phase.ordinal, phase.status])).toEqual([['i0001-p1', 1, 'PLANNED']]);
  });

  it('never hands out a number twice when several parts of one process create at once', async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, (_, i) => store.createInitiative({ repoPath: REPO, title: `T${i}`, goal: '' })));
    expect(new Set(ids.map((i) => i.id)).size).toBe(12);
  });

  it('shares one connection per file, and closes it with the last user', async () => {
    const second = await openStore(file);
    const created = await second.createInitiative({ repoPath: REPO, title: 'Seen by both', goal: '' });
    second.close();

    expect((await store.getInitiative(created.id))!.title).toBe('Seen by both'); // still open for the first
  });

  it('never hands out a number twice across processes either', async () => {
    // Real child processes: that is how the factory writes (several runs, the watcher, the CLI).
    const workers = Array.from({ length: 3 }, (_, worker) => runWorker(file, worker, 4));
    const outputs = await Promise.all(workers);
    const ids = outputs.flat();

    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect([...ids].sort()).toEqual(Array.from({ length: 12 }, (_, i) => `i${String(i + 1).padStart(4, '0')}`));
  }, 60_000);

  it('is found again by a new connection: it is on disk', async () => {
    await store.createInitiative({ repoPath: REPO, title: 'A', goal: 'a', firstPhase: { title: 'A' } });
    const again = await withStore((s) => s.getInitiative('i0001'), file);
    expect(again?.title).toBe('A');
  });
});

describe('a roadmap', () => {
  it('turns a quick task into a project: phase 1 keeps its run, the others are planned after it', async () => {
    const project = await projectWithPhaseRunning();

    expect(project).toMatchObject({ kind: 'project', title: 'Professional redesign of the frontend' });
    expect(project.phases.map((p) => [p.ordinal, p.title, p.status])).toEqual([
      [1, 'Design tokens, dark mode and app shell', 'RUNNING'],
      [2, 'Investment pages and modals', 'PLANNED'],
      [3, 'Accessibility and cleanup', 'PLANNED'],
    ]);
    expect(project.phases[0]).toMatchObject({ taskId: 'f0042', rootRunId: 'run-1', scope: ['tokens', 'theme toggle', 'header'] });
  });

  it('chains the phases by default, and honours the dependencies the architect gave', async () => {
    const project = await projectWithPhaseRunning();

    expect(project.phases[1]!.dependsOn).toEqual(['i0001-p1']); // default: the one before
    expect(project.phases[2]!.dependsOn).toEqual(['i0001-p2']); // as given
  });

  it('is written once when the same task is planned twice (the human answered a question in between)', async () => {
    const project = await projectWithPhaseRunning();
    const again = await store.setRoadmap(project.id, { ...uiRefactor, title: 'Redesign, take two' });

    expect(again.phases).toHaveLength(3);
    expect(again.title).toBe('Redesign, take two');
  });

  it('never rewrites a phase that has started', async () => {
    const project = await projectWithPhaseRunning();
    await store.linkRun(project.phases[1]!.id, { taskId: 'f0043', rootRunId: 'run-2', branch: 'factory/f0043/feat-y' });

    const again = await store.setRoadmap(project.id, {
      title: project.title,
      phases: [uiRefactor.phases[0]!, { title: 'Something else entirely' }, { title: 'And another' }],
    });

    expect(again.phases.map((p) => [p.ordinal, p.title, p.status])).toEqual([
      [1, 'Design tokens, dark mode and app shell', 'RUNNING'],
      [2, 'Investment pages and modals', 'RUNNING'], // kept
      [3, 'Something else entirely', 'PLANNED'],
      [4, 'And another', 'PLANNED'],
    ]);
  });

  it('refuses a roadmap of one phase: that is not a roadmap', async () => {
    const created = await store.createInitiative({ repoPath: REPO, title: 'A', goal: '', firstPhase: { title: 'A' } });
    await expect(store.setRoadmap(created.id, { title: 'A', phases: [{ title: 'A' }] })).rejects.toThrow('at least one more');
  });

  it('keeps what the user answered at the architect\'s questions', async () => {
    const created = await store.createInitiative({
      repoPath: REPO, title: 'A', goal: '', firstPhase: { title: 'A' },
      decisions: [{ questions: ['PR per phase?'], answer: '8) per phases', at: '2026-10-19T17:13:00Z' }],
    });
    const project = await store.setRoadmap(created.id, { title: 'A', phases: [{ title: 'One' }, { title: 'Two' }] });
    expect(project.decisions).toEqual([{ questions: ['PR per phase?'], answer: '8) per phases', at: '2026-10-19T17:13:00Z' }]);
  });
});

describe('the life of a phase', () => {
  it('goes planned, running, in review, merged - and the initiative is done when nothing is left', async () => {
    const project = await projectWithPhaseRunning();
    const [one, two, three] = project.phases.map((phase) => phase.id) as [string, string, string];

    await store.linkPullRequest(one, { number: 8, url: 'https://github.com/o/r/pull/8' });
    expect((await store.getPhase(one))!).toMatchObject({ status: 'IN_REVIEW', prNumber: 8 });
    expect((await store.findPhaseByPullRequest(REPO, 8))!.id).toBe(one);
    expect((await store.findPhaseByTask('f0042'))!.id).toBe(one);

    const merged = await store.markMerged(one, { sha: 'abc123', at: '2026-10-19T17:49:45Z' });
    expect(merged!.phase).toMatchObject({ status: 'MERGED', mergedSha: 'abc123' });
    expect(merged!.initiative.status).toBe('ACTIVE');

    await store.updatePhase(two, { status: 'SKIPPED' });
    expect((await store.markMerged(three))!.initiative.status).toBe('DONE');
  });

  it('offers the next phase only when what it depends on is delivered', async () => {
    const project = await projectWithPhaseRunning();
    const [one, two, three] = project.phases.map((phase) => phase.id) as [string, string, string];

    expect(await store.nextPhase(project.id)).toBeNull(); // phase 1 has not been merged
    await store.markMerged(one);
    expect((await store.nextPhase(project.id))!.id).toBe(two);
    await store.updatePhase(two, { status: 'RUNNING' });
    expect(await store.nextPhase(project.id)).toBeNull(); // phase 3 waits for phase 2
    await store.markMerged(two);
    expect((await store.nextPhase(project.id))!.id).toBe(three);
  });

  it('sends a phase back to the roadmap when its pull request is closed without merging', async () => {
    const project = await projectWithPhaseRunning();
    const one = project.phases[0]!.id;
    await store.linkPullRequest(one, { number: 8, url: 'u' });

    await store.markClosedUnmerged(one);
    expect(await store.getPhase(one)).toMatchObject({ status: 'PLANNED', prNumber: null, prUrl: null });

    await store.markMerged(one);
    await store.markClosedUnmerged(one); // a merged phase stays merged
    expect((await store.getPhase(one))!.status).toBe('MERGED');
  });

  it('takes edits to the words of a phase, and notes with their source', async () => {
    const project = await projectWithPhaseRunning();
    const two = project.phases[1]!.id;

    await store.updatePhase(two, { title: 'Detail screens', scope: ['a', 'b'], acceptance: ['c'] });
    await store.appendNotes(two, [{ source: 'user-request', text: 'Investment Details is white in dark mode' }]);

    const phase = (await store.getPhase(two))!;
    expect(phase).toMatchObject({ title: 'Detail screens', scope: ['a', 'b'], acceptance: ['c'] });
    expect(phase.notes).toEqual([{ at: expect.any(String), source: 'user-request', text: 'Investment Details is white in dark mode' }]);
  });

  it('adds a phase at the end', async () => {
    const project = await projectWithPhaseRunning();
    const added = await store.addPhase(project.id, { title: 'Charts', dependsOnOrdinals: [3, 9] });

    expect(added).toMatchObject({ ordinal: 4, status: 'PLANNED', dependsOn: ['i0001-p3'] }); // a later phase cannot be a dependency
  });
});

describe('listing', () => {
  it('leaves quick tasks out unless asked, and other repositories always', async () => {
    await projectWithPhaseRunning();
    await store.createInitiative({ repoPath: REPO, title: 'Quick', goal: '', firstPhase: { title: 'Quick' } });
    await store.createInitiative({ repoPath: '/elsewhere', title: 'Other', goal: '', kind: 'project', firstPhase: { title: 'Other' } });

    expect((await store.listInitiatives(REPO)).map((i) => i.title)).toEqual(['Professional redesign of the frontend']);
    expect((await store.listInitiatives(REPO, { includeQuick: true })).map((i) => i.title)).toEqual(['Quick', 'Professional redesign of the frontend']);
  });
});

describe('the backlog', () => {
  it('keeps what was seen on the way, once, however it is worded', async () => {
    const project = await projectWithPhaseRunning();

    const first = await store.addBacklog(project.id, [
      { source: 'security', text: 'XSS in ChartUtils.js:37 (self-XSS)', severity: 'INFO', evidence: 'tooltip builds HTML', phaseId: project.phases[0]!.id },
      { source: 'review', text: '  The new code mixes var and const.  ' },
    ]);
    const again = await store.addBacklog(project.id, [{ source: 'review', text: 'the new code MIXES var and const' }, { source: 'user', text: '   ' }]);

    expect([first, again]).toEqual([2, 0]);
    const open = await store.listBacklog(project.id, 'OPEN');
    expect(open.map((item) => item.text)).toEqual(['XSS in ChartUtils.js:37 (self-XSS)', 'The new code mixes var and const.']);
    expect(open[0]).toMatchObject({ id: 'b0001', source: 'security', severity: 'INFO', phaseId: 'i0001-p1' });
    expect((await store.getInitiative(project.id))!.backlogOpen).toBe(2);
  });

  it('lets an item be set aside or promoted', async () => {
    const project = await projectWithPhaseRunning();
    await store.addBacklog(project.id, [{ source: 'review', text: 'one' }, { source: 'review', text: 'two' }]);

    await store.setBacklogStatus('b0001', 'DISMISSED');
    await store.setBacklogStatus('b0002', 'PROMOTED');

    expect(await store.listBacklog(project.id, 'OPEN')).toEqual([]);
    expect((await store.getBacklogItem('b0002'))!.status).toBe('PROMOTED');
  });

  it('fingerprints the words and not the punctuation', () => {
    expect(fingerprintOf('Sign colour: leaks!')).toBe(fingerprintOf('sign  colour leaks'));
  });
});

describe('decisions about review comments', () => {
  it('records a choice per comment, and the last choice wins', async () => {
    const key = `${REPO}#8`;
    await store.recordScopeDecision({ prKey: key, commentId: 'c1', initiativeId: 'i0001', fromPhaseId: 'i0001-p1', targetPhaseId: 'i0001-p2', decision: 'DEFER', excerpt: 'Investment Details is white' });
    await store.recordScopeDecision({ prKey: key, commentId: 'c2', initiativeId: 'i0001', fromPhaseId: 'i0001-p1', targetPhaseId: null, decision: 'DO_NOW', excerpt: 'zoom' });
    await store.recordScopeDecision({ prKey: key, commentId: 'c1', initiativeId: 'i0001', fromPhaseId: 'i0001-p1', targetPhaseId: null, decision: 'DO_NOW', excerpt: 'Investment Details is white' });

    const decisions = await store.listScopeDecisions(key);
    expect(decisions.map((d) => [d.commentId, d.decision, d.targetPhaseId])).toEqual([['c1', 'DO_NOW', null], ['c2', 'DO_NOW', null]]);
    expect(await store.listScopeDecisions(`${REPO}#9`)).toEqual([]);
  });
});

describe('the database', () => {
  it('knows its version and refuses a newer one rather than guess', async () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    store.close();
    const { createClient } = await import('@libsql/client');
    const raw = createClient({ url: `file:${file}` });
    await raw.execute({ sql: 'UPDATE schema_meta SET version = ?', args: [SCHEMA_VERSION + 5] });
    raw.close();

    await expect(openStore(file)).rejects.toThrow('from a newer factory');
    store = await openStore(path.join(dir, 'fresh.db')); // so afterEach has something to close
  });

  it('keeps what a failed change started: nothing', async () => {
    const created = await store.createInitiative({ repoPath: REPO, title: 'A', goal: '', firstPhase: { title: 'A' } });
    await expect(store.setRoadmap(created.id, { title: 'Renamed', phases: [{ title: 'only one' }] })).rejects.toThrow();
    expect((await store.getInitiative(created.id))!.title).toBe('A');
  });
});
