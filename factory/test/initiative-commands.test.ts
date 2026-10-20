import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyRuns, RUN } from '../../fixtures';

vi.mock('../src/utils/agent-runner.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/agent-runner.ts')>()),
  invokeAgent: vi.fn(),
}));
import { invokeAgent } from '../src/utils/agent-runner.ts';

import { commandInitiativeEdit, commandInitiativeList, commandPhaseReconcile } from '../src/cli/initiatives.ts';
import { withStore } from '../src/initiatives/store.ts';

let root: string;
let logs: string;
let repo: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cli-'));
  logs = path.join(root, 'logs');
  repo = path.join(root, 'workspace', 'invest-track');
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  vi.stubEnv('FACTORY_LOG_DIR', logs);
  vi.stubEnv('FACTORY_WORKSPACE_ROOT', path.join(root, 'workspace'));
});
afterEach(() => {
  vi.mocked(invokeAgent).mockReset();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Runs a command and returns what it printed: the exit code, the marker payload, and stderr. */
async function run(command: (flags: Record<string, string | boolean>) => Promise<number>, flags: Record<string, string | boolean>, marker: string) {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (err.push(String(chunk)), true));
  try {
    const code = await command(flags);
    const lines = out.join('').split('\n').filter((line) => line.startsWith(`${marker} `));
    return { code, lines, payload: lines[0] ? JSON.parse(lines[0].slice(marker.length + 1)) : null, stderr: err.join('') };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

/** A planned project (phase 1 merged, two waiting) and a quick task, both of this repository. */
async function seed() {
  await withStore(async (store) => {
    const project = await store.createInitiative({ repoPath: repo, title: 'Redesign', goal: 'Redesign', firstPhase: { title: 'Foundation' } });
    await store.linkRun(project.phases[0]!.id, { taskId: 'f0042', rootRunId: RUN.round1, branch: 'factory/f0042/feat-x' });
    const set = await store.setRoadmap(project.id, { title: 'Redesign the frontend', phases: [{ title: 'Foundation' }, { title: 'Screens' }, { title: 'Cleanup' }] });
    await store.linkPullRequest(set.phases[0]!.id, { number: 8, url: 'https://github.com/o/r/pull/8' });
    await store.markMerged(set.phases[0]!.id);
    await store.createInitiative({ repoPath: repo, title: 'Fix the typo', goal: 'Fix the typo', kind: 'quick', firstPhase: { title: 'Fix the typo' } });
  });
}

describe('initiative-list', () => {
  it('needs a repository', async () => {
    const result = await run(commandInitiativeList, {}, 'INITIATIVE_LIST_JSON');

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--repo is required');
    expect(result.payload).toBeNull();
  });

  it('says so, in the marker, when the repository is not there', async () => {
    const result = await run(commandInitiativeList, { repo: 'no-such-repo' }, 'INITIATIVE_LIST_JSON');

    expect(result.code).toBe(1);
    expect(result.payload.error).toContain('Target repository not found');
  });

  it('prints one line: the projects, which phase can start, and leaves out the quick tasks', async () => {
    await seed();
    const result = await run(commandInitiativeList, { repo: 'invest-track' }, 'INITIATIVE_LIST_JSON');

    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.payload.repoPath).toBe(repo);
    expect(result.payload.initiatives.map((initiative: { title: string }) => initiative.title)).toEqual(['Redesign the frontend']);
    const [project] = result.payload.initiatives;
    expect(project.nextPhaseId).toBe('i0001-p2');
    expect(project.phases.map((phase: { ordinal: number; status: string; ready: boolean }) => [phase.ordinal, phase.status, phase.ready])).toEqual([[1, 'MERGED', false], [2, 'PLANNED', true], [3, 'PLANNED', false]]);
  });

  it('includes the quick tasks when asked', async () => {
    await seed();
    const result = await run(commandInitiativeList, { repo: 'invest-track', 'include-quick': true }, 'INITIATIVE_LIST_JSON');

    expect(result.payload.initiatives.map((initiative: { title: string }) => initiative.title)).toEqual(['Fix the typo', 'Redesign the frontend']);
  });

  it('keeps projects of another repository out', async () => {
    await seed();
    fs.mkdirSync(path.join(root, 'workspace', 'other'));
    const result = await run(commandInitiativeList, { repo: 'other' }, 'INITIATIVE_LIST_JSON');

    expect(result.payload.initiatives).toEqual([]);
  });
});

describe('initiative-edit', () => {
  it('needs the project and the edit', async () => {
    expect((await run(commandInitiativeEdit, { patch: '{}' }, 'INITIATIVE_EDIT_JSON')).code).toBe(2);
    expect((await run(commandInitiativeEdit, { initiative: 'i0001' }, 'INITIATIVE_EDIT_JSON')).code).toBe(2);
  });

  it('changes the roadmap and prints it as it is now', async () => {
    await seed();
    const result = await run(commandInitiativeEdit, { initiative: 'i0001', patch: JSON.stringify({ phases: [{ id: 'i0001-p2', status: 'SKIPPED' }], addPhases: [{ title: 'Docs' }] }) }, 'INITIATIVE_EDIT_JSON');

    expect(result.code).toBe(0);
    const phases = result.payload.initiative.phases;
    expect(phases.map((phase: { title: string; status: string }) => [phase.title, phase.status])).toEqual([['Foundation', 'MERGED'], ['Screens', 'SKIPPED'], ['Cleanup', 'PLANNED'], ['Docs', 'PLANNED']]);
    expect(result.payload.initiative.nextPhaseId).toBe('i0001-p3');
  });

  it('tells the user why an edit was refused, and changes nothing', async () => {
    await seed();
    const result = await run(commandInitiativeEdit, { initiative: 'i0001', patch: JSON.stringify({ title: 'Renamed', phases: [{ id: 'i0001-p1', status: 'SKIPPED' }] }) }, 'INITIATIVE_EDIT_JSON');

    expect(result.code).toBe(1);
    expect(result.payload.error).toBe('Phase 1 ("Foundation") is merged: it cannot be made skipped by hand.');
    expect((await withStore((store) => store.getInitiative('i0001')))!.title).toBe('Redesign the frontend');
  });

  it('tells the user when the edit itself is not valid', async () => {
    await seed();
    const result = await run(commandInitiativeEdit, { initiative: 'i0001', patch: '{"colour":"red"}' }, 'INITIATIVE_EDIT_JSON');

    expect(result.code).toBe(1);
    expect(result.payload.error).toContain('The edit is not valid');
  });
});

describe('phase-reconcile', () => {
  it('needs a phase', async () => {
    expect((await run(commandPhaseReconcile, {}, 'PHASE_RECONCILE_JSON')).code).toBe(2);
  });

  it('has nothing to do for a phase that is not merged: a null report, not an error', async () => {
    await seed();
    const result = await run(commandPhaseReconcile, { phase: 'i0001-p2' }, 'PHASE_RECONCILE_JSON');

    expect(result.code).toBe(0);
    expect(result.payload).toEqual({ report: null });
    expect(invokeAgent).not.toHaveBeenCalled();
  });

  it('compares a merged phase with the rest of the roadmap and prints what changed', async () => {
    await seed();
    copyRuns(logs, [RUN.round1, RUN.round2]);
    vi.mocked(invokeAgent).mockResolvedValue({
      object: { summary: 'Foundation delivered.', phases: [{ phaseId: 'i0001-p2', status: 'DONE', note: 'Round 2 did the screens.', remainingScope: [] }], backlog: [] },
      servedByModel: 'claude-haiku-5-5',
      durationMs: 800,
    } as never);

    const result = await run(commandPhaseReconcile, { phase: 'i0001-p1' }, 'PHASE_RECONCILE_JSON');

    expect(result.code).toBe(0);
    expect(result.payload.report).toMatchObject({ source: 'agent', changes: [{ phaseId: 'i0001-p2', status: 'DONE' }] });
    expect((await withStore((store) => store.getPhase('i0001-p2')))!.status).toBe('SKIPPED');
  });

  it('asks again only when told to', async () => {
    await seed();
    copyRuns(logs, [RUN.round1]);
    vi.mocked(invokeAgent).mockResolvedValue({ object: { summary: 'Done.', phases: [], backlog: [] }, servedByModel: 'm', durationMs: 1 } as never);

    await run(commandPhaseReconcile, { phase: 'i0001-p1' }, 'PHASE_RECONCILE_JSON');
    expect((await run(commandPhaseReconcile, { phase: 'i0001-p1' }, 'PHASE_RECONCILE_JSON')).payload).toEqual({ report: null });
    expect((await run(commandPhaseReconcile, { phase: 'i0001-p1', force: true }, 'PHASE_RECONCILE_JSON')).payload.report).toMatchObject({ source: 'agent' });
  });
});
