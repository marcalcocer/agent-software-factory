/**
 * The real workflow, on a real git repository, with the model calls the only thing mocked.
 *
 * What a task does to the user's folder is not something a unit test can show: it takes the whole run -
 * prepare, plan, develop, the real test command, the gates, the commit - and a repository to look at
 * afterwards. Each call to an agent answers with the stub the call site provides for a dry run (so the
 * routing is the real routing), and the developer "edits" by writing a file where it was told to work,
 * which is all the real one does through its tools.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/agent-runner.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/agent-runner.ts')>()),
  invokeAgent: vi.fn(),
}));
import { invokeAgent } from '../src/utils/agent-runner.ts';

import { withStore } from '../src/initiatives/store.ts';
import { generateRunId, traceDirFor } from '../src/tools/logger-tools.ts';
import { worktreePathFor } from '../src/tools/worktree.ts';
import { createWorkspaceRepo, type WorkspaceRepo } from './support/git-repo.ts';

const ask = vi.mocked(invokeAgent);
const SAVED_ENV = { ...process.env };
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-e2e-'));

let mastra: typeof import('../src/mastra/index.ts')['mastra'];
let ws: WorkspaceRepo;

beforeAll(async () => {
  // Read when Mastra is created, so before it is imported.
  process.env.FACTORY_LOG_DIR = path.join(home, 'logs');
  process.env.FACTORY_STORAGE_URL = `file:${path.join(home, 'logs', 'factory.db')}`;
  process.env.FACTORY_LOG_LEVEL = 'error';
  process.env.FACTORY_ENABLE_REPOMIX = 'false';
  process.env.FACTORY_ALLOW_PUSH = 'false';
  process.env.FACTORY_ALLOW_PR = 'false';
  process.env.FACTORY_NON_INTERACTIVE = 'true';
  ({ mastra } = await import('../src/mastra/index.ts'));
}, 60_000);

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in SAVED_ENV)) delete process.env[key];
  Object.assign(process.env, SAVED_ENV);
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  ws = createWorkspaceRepo();
  vi.stubEnv('FACTORY_WORKSPACE_ROOT', ws.workspace);
  ask.mockImplementation((async (options: { role: string; repoPath: string; runId: string; dryRunResult: unknown }) => {
    // What the developer does through its tools: change files in the folder it was given.
    if (options.role === 'developer') {
      fs.mkdirSync(path.join(options.repoPath, 'src'), { recursive: true });
      fs.writeFileSync(path.join(options.repoPath, 'src', `change-${options.runId.slice(-4)}.js`), `module.exports = '${options.runId}';\n`);
    }
    return {
      object: options.dryRunResult,
      text: '',
      requestedModel: 'mock',
      servedByModel: 'mock',
      failedOver: false,
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, totalTokens: 2 },
      toolCalls: 0,
      durationMs: 1,
      dryRun: false,
    };
  }) as never);
});
afterEach(() => {
  ask.mockReset();
  ws.cleanup();
});

const TASK = 'Add a helper that greets a user by name, and use it from the entry point.';

async function runTask(extra: Record<string, unknown> = {}, task = TASK) {
  const workflow = mastra.getWorkflow('softwareFactoryWorkflow');
  const runId = generateRunId('e2e');
  const run = await workflow.createRun({ runId });
  const result = await run.start({
    inputData: { task, repo: ws.repo, maxAttempts: 2, autoCommit: true, createPullRequest: false, interactive: false, ...extra } as never,
  });
  // A run that fails before its trace is opened has no run.json (the CLI writes one the moment it starts a run).
  let meta: Record<string, any> = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(traceDirFor(runId), 'run.json'), 'utf8'));
  } catch {
    // nothing recorded
  }
  return { runId, result, meta };
}

const delivered = (result: Awaited<ReturnType<typeof runTask>>['result']): string =>
  result.status === 'success' ? String((result.result as { status: string }).status) : `${result.status}: ${result.status === 'failed' ? String(result.error?.message) : ''}`;
const branchOf = (cwd: string) => ws.gitIn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
const calls = (role: string) => ask.mock.calls.map(([options]) => options as unknown as { role: string; repoPath: string; runId: string }).filter((options) => options.role === role);

describe('a task in its own checkout (the default)', () => {
  it('does the work there, and the user\'s repository does not notice', async () => {
    const before = ws.git('rev-parse', 'HEAD').trim();
    const { runId, result, meta } = await runTask();

    expect(delivered(result)).toBe('DELIVERED_WITHOUT_PR');
    const tree = worktreePathFor(ws.repo, meta.taskId);

    // Where it happened - recorded for the screens, and filed under the user's repository.
    expect(meta).toMatchObject({ isolation: 'worktree', workPath: tree, repoPath: ws.repo });
    expect(meta.branch).toMatch(new RegExp(`^factory/${meta.taskId}/`));
    expect(JSON.parse(fs.readFileSync(path.join(traceDirFor(runId), 'summary.json'), 'utf8')).repository).toBe(ws.repo);

    // The user's folder: same branch, same commit, nothing new in it.
    expect(branchOf(ws.repo)).toBe('main');
    expect(ws.git('rev-parse', 'HEAD').trim()).toBe(before);
    expect(ws.git('status', '--porcelain').trim()).toBe('');
    expect(fs.readdirSync(path.join(ws.repo, 'src'))).toEqual(['index.js']);

    // The checkout: the task's branch, the developer's file committed on it, with the task's trailer.
    expect(branchOf(tree)).toBe(meta.branch);
    expect(ws.gitIn(tree, 'status', '--porcelain').trim()).toBe('');
    expect(ws.gitIn(tree, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).toContain(`src/change-${runId.slice(-4)}.js`);
    expect(ws.gitIn(tree, 'log', '-1', '--format=%B')).toContain(`Factory-Task: ${meta.taskId}`);
    expect(ws.gitIn(tree, 'rev-list', '--count', `${before}..HEAD`).trim()).toBe('1');
  }, 120_000);

  it('hands every agent that works on the code the checkout, not the user\'s folder', async () => {
    const { meta } = await runTask();
    const tree = worktreePathFor(ws.repo, meta.taskId);

    for (const role of ['pm-architect', 'developer', 'qa-tester', 'reviewer', 'security', 'documentation', 'pr-writer']) {
      const seen = calls(role);
      expect(seen.length, role).toBeGreaterThan(0);
      for (const call of seen) expect(call.repoPath, role).toBe(tree);
    }
  }, 120_000);

  it('does not mind what the user has open in their folder - they can keep working while it runs', async () => {
    fs.writeFileSync(path.join(ws.repo, 'README.md'), '# app, being edited right now\n');
    fs.writeFileSync(path.join(ws.repo, 'scratch.txt'), 'not committed\n');

    const { result, meta } = await runTask();

    expect(delivered(result)).toBe('DELIVERED_WITHOUT_PR');
    expect(fs.readFileSync(path.join(ws.repo, 'README.md'), 'utf8')).toBe('# app, being edited right now\n');
    expect(fs.readFileSync(path.join(ws.repo, 'scratch.txt'), 'utf8')).toBe('not committed\n');
    const tree = worktreePathFor(ws.repo, meta.taskId);
    expect(ws.gitIn(tree, 'show', '--name-only', '--format=', 'HEAD')).not.toContain('README.md');
    expect(ws.gitIn(tree, 'show', '--name-only', '--format=', 'HEAD')).not.toContain('scratch.txt');
  }, 120_000);

  it('files the task under the user\'s repository, not under the checkout', async () => {
    await runTask();

    const projects = await withStore((store) => store.listInitiatives(ws.repo, { includeQuick: true }));
    expect(projects).toHaveLength(1);
    expect(projects[0]!.repoPath).toBe(ws.repo);
    expect(await withStore((store) => store.listInitiatives(path.join(ws.workspace, '.factory'), { includeQuick: true }))).toEqual([]);
  }, 120_000);

  it('runs two tasks on one repository at the same time - each in its own checkout', async () => {
    const [first, second] = await Promise.all([
      runTask({}, 'Add a helper that greets a user by name, and use it from the entry point.'),
      runTask({}, 'Add a helper that formats a price with two decimals, and use it from the entry point.'),
    ]);

    expect(delivered(first.result)).toBe('DELIVERED_WITHOUT_PR');
    expect(delivered(second.result)).toBe('DELIVERED_WITHOUT_PR');
    expect(first.meta.taskId).not.toBe(second.meta.taskId);
    expect(first.meta.workPath).not.toBe(second.meta.workPath);
    expect(first.meta.branch).not.toBe(second.meta.branch);
    for (const { runId, meta } of [first, second]) {
      expect(ws.gitIn(meta.workPath, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).toContain(`src/change-${runId.slice(-4)}.js`);
    }
    expect(branchOf(ws.repo)).toBe('main');
    expect(ws.git('status', '--porcelain').trim()).toBe('');
  }, 180_000);

  it('links the dependencies instead of installing them, and the link is not committed', async () => {
    const { meta } = await runTask();

    expect(fs.lstatSync(path.join(meta.workPath, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(ws.gitIn(meta.workPath, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('node_modules');
  }, 120_000);
});

describe('a further round', () => {
  const roundOf = (first: Awaited<ReturnType<typeof runTask>>) => ({
    parentRunId: first.runId,
    rootRunId: first.runId,
    round: 2,
    action: 'RERUN_IMPLEMENTATION' as const,
    originalTask: TASK,
    pullRequest: { number: 8, url: 'https://github.com/o/r/pull/8', headBranch: first.meta.branch as string, baseBranch: 'main' },
    comments: [{ id: 'c1', source: 'REVIEW_THREAD' as const, author: 'marc', body: 'Please also handle an empty name.', path: 'src/index.js', line: 1, category: 'CODE_CHANGE_REQUEST' }],
    title: 'Handle an empty name',
  });
  const round = (first: Awaited<ReturnType<typeof runTask>>) =>
    runTask({ revision: roundOf(first), baseBranch: 'main', branchName: first.meta.branch }, 'Address the review comments on pull request #8.');

  it('works in the same checkout, on the same branch, and adds its commit to it', async () => {
    const first = await runTask();
    const second = await round(first);

    expect(delivered(second.result)).toBe('DELIVERED_WITHOUT_PR');
    expect(second.meta).toMatchObject({ kind: 'revision', round: 2, isolation: 'worktree', workPath: first.meta.workPath, taskId: first.meta.taskId, branch: first.meta.branch });
    expect(ws.gitIn(first.meta.workPath, 'rev-list', '--count', `main..${first.meta.branch}`).trim()).toBe('2');
    expect(ws.gitIn(first.meta.workPath, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).toEqual(
      expect.arrayContaining([`src/change-${first.runId.slice(-4)}.js`, `src/change-${second.runId.slice(-4)}.js`]),
    );
    expect(branchOf(ws.repo)).toBe('main');
  }, 240_000);

  it('brings the checkout back from the branch when the user deleted the folder in between', async () => {
    const first = await runTask();
    fs.rmSync(first.meta.workPath, { recursive: true, force: true });

    const second = await round(first);

    expect(delivered(second.result)).toBe('DELIVERED_WITHOUT_PR');
    expect(second.meta.workPath).toBe(first.meta.workPath);
    expect(ws.gitIn(first.meta.workPath, 'rev-list', '--count', `main..${first.meta.branch}`).trim()).toBe('2');
    expect(fs.existsSync(path.join(first.meta.workPath, 'src', `change-${first.runId.slice(-4)}.js`))).toBe(true);
  }, 240_000);

  it('stops, naming the folder, when the checkout still has changes an earlier run left in it', async () => {
    const first = await runTask();
    fs.writeFileSync(path.join(first.meta.workPath, 'half-done.txt'), 'x\n');

    const second = await round(first);

    expect(second.result.status).toBe('failed');
    expect(String((second.result as { error?: Error }).error?.message)).toContain(`The checkout at ${first.meta.workPath} has uncommitted changes`);
  }, 240_000);
});

describe('a task in the user\'s own repository (in place)', () => {
  it('still works as before: the branch is made and checked out in their folder', async () => {
    const { runId, result, meta } = await runTask({ isolation: 'in-place' });

    expect(delivered(result)).toBe('DELIVERED_WITHOUT_PR');
    expect(meta).toMatchObject({ isolation: 'in-place', workPath: ws.repo, repoPath: ws.repo });
    expect(branchOf(ws.repo)).toBe(meta.branch);
    expect(ws.git('ls-tree', '-r', '--name-only', 'HEAD').split('\n')).toContain(`src/change-${runId.slice(-4)}.js`);
    expect(fs.existsSync(path.join(ws.workspace, '.factory'))).toBe(false);
  }, 120_000);

  it('keeps a further round in place too - a task keeps the place it started in', async () => {
    const first = await runTask({ isolation: 'in-place' });
    const second = await runTask(
      {
        revision: {
          parentRunId: first.runId, rootRunId: first.runId, round: 2, action: 'RERUN_IMPLEMENTATION', originalTask: TASK,
          pullRequest: { number: 8, url: 'https://github.com/o/r/pull/8', headBranch: first.meta.branch, baseBranch: 'main' },
          comments: [{ id: 'c1', source: 'REVIEW_THREAD', author: 'marc', body: 'Please also handle an empty name.', path: 'src/index.js', line: 1, category: 'CODE_CHANGE_REQUEST' }],
          title: 'Handle an empty name',
        },
        baseBranch: 'main',
        branchName: first.meta.branch,
      },
      'Address the review comments on pull request #8.',
    );

    expect(delivered(second.result)).toBe('DELIVERED_WITHOUT_PR');
    expect(second.meta).toMatchObject({ isolation: 'in-place', workPath: ws.repo });
    expect(branchOf(ws.repo)).toBe(first.meta.branch);
    expect(ws.git('rev-list', '--count', `main..${first.meta.branch}`).trim()).toBe('2');
    expect(fs.existsSync(path.join(ws.workspace, '.factory'))).toBe(false);
  }, 240_000);

  it('still refuses to start over uncommitted changes - there the diff would not be the task\'s alone', async () => {
    fs.writeFileSync(path.join(ws.repo, 'README.md'), '# edited\n');

    const { result } = await runTask({ isolation: 'in-place' });

    expect(result.status).toBe('failed');
    expect(String((result as { error?: Error }).error?.message)).toContain('has uncommitted changes');
  }, 120_000);

  it('can be made the default for every task with FACTORY_ISOLATION', async () => {
    vi.stubEnv('FACTORY_ISOLATION', 'in-place');

    const { meta } = await runTask();

    expect(meta.isolation).toBe('in-place');
  }, 120_000);
});

describe('a run of one phase of a roadmap', () => {
  async function roadmap() {
    return await withStore(async (store) => {
      const created = await store.createInitiative({ repoPath: ws.repo, title: 'Todo manager', goal: 'A todo manager', firstPhase: { title: 'Core storage module' } });
      const set = await store.setRoadmap(created.id, {
        title: 'Todo manager',
        phases: [
          { title: 'Core storage module', scope: ['src/store.js'] },
          // The scope mentions "dependencies": it is not a change to the dependencies.
          { title: 'Command-line interface', goal: 'A CLI with add, list and done.', scope: ['argument parsing without dependencies', 'a bin entry in package.json'] },
          { title: 'README with full usage documentation', scope: ['README.md'] },
        ],
      });
      await store.markMerged(set.phases[0]!.id);
      await store.markMerged(set.phases[1]!.id); // so phase 3 can start
      return set;
    });
  }

  it.each([
    ['i0001-p2', 'Command-line interface', 'feat'],
    ['i0001-p3', 'README with full usage documentation', 'docs'],
  ])('names its branch from the phase title: %s -> %s', async (phaseOrdinal, title, type) => {
    const project = await roadmap(); // (the store is shared by the whole file, so the ids are not the same in every test)
    const phaseId = `${project.id}-p${phaseOrdinal.at(-1)}`;
    await withStore((store) => store.updatePhase(phaseId, { status: 'PLANNED' })); // the one under test is waiting

    const { result, meta } = await runTask({ phase: { initiativeId: project.id, phaseId } }, `Phase of "Todo manager": ${title}\n\nScope:\n- argument parsing without dependencies`);

    expect(delivered(result)).toBe('DELIVERED_WITHOUT_PR');
    expect(meta).toMatchObject({ title, titleSource: 'phase', phaseId });
    expect(meta.branch).toMatch(new RegExp(`^factory/${meta.taskId}/${type}-`));
  }, 120_000);
});

describe('the phase a run belongs to, when the run ends without a pull request', () => {
  const phaseOf = async (initiativeId: string) => (await withStore((store) => store.getInitiative(initiativeId)))!.phases[0]!;

  it('goes back to the roadmap - it is not running any more, and says what happened', async () => {
    const { result, meta } = await runTask(); // commits on its branch; no pull request is asked for

    expect(delivered(result)).toBe('DELIVERED_WITHOUT_PR');
    const phase = await phaseOf(meta.initiativeId);
    expect(phase.status).toBe('PLANNED');
    expect(phase.notes.at(-1)).toMatchObject({
      source: 'factory',
      text: `A run delivered this phase on the branch ${meta.branch} without opening a pull request, so it is not in review. Run it again, or skip it.`,
    });
  }, 120_000);

  it('can then be run again - the roadmap does not refuse a phase that was released', async () => {
    const { meta } = await runTask();

    const { resolvePhaseRequest } = await import('../src/initiatives/link.ts');
    expect(await resolvePhaseRequest({ phaseId: meta.phaseId })).toMatchObject({ ok: true });
  }, 120_000);

  it('stays in review when a further round delivers nothing new - the pull request is still open', async () => {
    const first = await runTask();
    await withStore((store) => store.linkPullRequest(first.meta.phaseId, { number: 8, url: 'https://github.com/o/r/pull/8' }));
    const round = {
      parentRunId: first.runId, rootRunId: first.runId, round: 2, action: 'RERUN_IMPLEMENTATION' as const, originalTask: TASK,
      pullRequest: { number: 8, url: 'https://github.com/o/r/pull/8', headBranch: first.meta.branch as string, baseBranch: 'main' },
      comments: [{ id: 'c1', source: 'REVIEW_THREAD' as const, author: 'marc', body: 'Please handle an empty name.', path: 'src/index.js', line: 1, category: 'CODE_CHANGE_REQUEST' }],
      title: 'Handle an empty name',
    };

    const second = await runTask({ revision: round, baseBranch: 'main', branchName: first.meta.branch }, 'Address the review comments on pull request #8.');

    expect(delivered(second.result)).toBe('DELIVERED_WITHOUT_PR');
    expect((await phaseOf(first.meta.initiativeId)).status).toBe('IN_REVIEW');
  }, 240_000);
});

describe('a repository outside the workspace, with the checkouts kept somewhere else', () => {
  /** The workspace is in one place, the repository in another, and the checkouts in a third. */
  function arrange(openIt: boolean) {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-e2e-other-workspace-'));
    const keep = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-e2e-checkouts-'));
    vi.stubEnv('FACTORY_WORKSPACE_ROOT', elsewhere);
    vi.stubEnv('FACTORY_WORKTREES_DIR', keep);
    vi.stubEnv('FACTORY_EXTRA_REPOS', openIt ? ws.repo : '');
    return { elsewhere, keep, cleanup: () => [elsewhere, keep].forEach((folder) => fs.rmSync(folder, { recursive: true, force: true })) };
  }

  it('is refused when nobody opened it - and the refusal says how', async () => {
    const places = arrange(false);
    try {
      const { result } = await runTask();

      expect(result.status).toBe('failed');
      expect(String((result as { error?: Error }).error?.message)).toContain(`Path "${ws.repo}" is outside the places the factory may work in`);
      expect(String((result as { error?: Error }).error?.message)).toContain('FACTORY_EXTRA_REPOS');
      expect(fs.readdirSync(places.keep)).toEqual([]); // nothing was made
    } finally {
      places.cleanup();
    }
  }, 120_000);

  it('works once it is opened: the task runs in a checkout under the chosen folder, and your repository is not touched', async () => {
    const places = arrange(true);
    try {
      const before = ws.git('rev-parse', 'HEAD').trim();
      const { runId, result, meta } = await runTask();

      expect(delivered(result)).toBe('DELIVERED_WITHOUT_PR');
      expect(meta.workPath).toBe(path.join(places.keep, 'app', meta.taskId));
      expect(meta).toMatchObject({ isolation: 'worktree', repoPath: ws.repo });
      expect(ws.gitIn(meta.workPath, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).toContain(`src/change-${runId.slice(-4)}.js`);
      expect(branchOf(ws.repo)).toBe('main');
      expect(ws.git('rev-parse', 'HEAD').trim()).toBe(before);
      expect(ws.git('status', '--porcelain').trim()).toBe('');
      expect(fs.existsSync(path.join(places.elsewhere, '.factory'))).toBe(false); // nothing went to the workspace
    } finally {
      places.cleanup();
    }
  }, 120_000);

  it('hands the agents a checkout the boundary accepts - they are confined to it, wherever it is kept', async () => {
    const places = arrange(true);
    try {
      const { meta } = await runTask();
      const { resolveRepoPath, isInside } = await import('../src/utils/factory-config.ts');
      // The case this is about: the checkout is NOT in the workspace, so only the boundary's own allowance admits it.
      expect(isInside(places.keep, meta.workPath)).toBe(true);
      expect(isInside(places.elsewhere, meta.workPath)).toBe(false);

      for (const role of ['pm-architect', 'developer', 'qa-tester', 'reviewer']) {
        const seen = calls(role);
        expect(seen.length, role).toBeGreaterThan(0);
        for (const call of seen) {
          expect(call.repoPath, role).toBe(meta.workPath);
          // The very check every tool of an agent makes before it touches anything.
          expect(resolveRepoPath(call.repoPath, { requireGit: true }), role).toBe(call.repoPath);
        }
      }
      // ...and only that: the repository next door is not theirs.
      expect(() => resolveRepoPath(path.join(ws.workspace, '..'), { requireGit: false })).toThrow('is outside the places the factory may work in');
    } finally {
      places.cleanup();
    }
  }, 120_000);

  it('is listed with its checkout - the commands that show the user where the work is find it', async () => {
    const places = arrange(true);
    try {
      const { meta } = await runTask();
      const { reportCheckouts } = await import('../src/tools/worktree-report.ts');

      const found = await reportCheckouts(ws.repo);

      expect(found.map((checkout) => [checkout.taskId, checkout.path, checkout.registered])).toEqual([[meta.taskId, meta.workPath, true]]);
    } finally {
      places.cleanup();
    }
  }, 120_000);
});

describe('what it will not do', () => {
  it('does not quietly work in the user\'s folder when the checkout cannot be made', async () => {
    // The user has the branch the task would use checked out in their own folder.
    ws.git('checkout', '-q', '-b', 'factory/mine');

    const { result } = await runTask({ branchName: 'factory/mine', baseBranch: 'main' });

    expect(result.status).toBe('failed');
    expect(String((result as { error?: Error }).error?.message)).toContain('is already checked out');
    expect(fs.readdirSync(path.join(ws.repo, 'src'))).toEqual(['index.js']);
  }, 120_000);

  it('makes no checkout in a rehearsal', async () => {
    vi.stubEnv('FACTORY_DRY_RUN', 'true');

    const { result, meta } = await runTask();

    expect(result.status).toBe('success');
    expect(meta.isolation).toBe('in-place');
    expect(fs.existsSync(path.join(ws.workspace, '.factory'))).toBe(false);
  }, 120_000);
});
