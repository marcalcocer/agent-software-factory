/**
 * The review of a pull request, through the real feedback workflow: a real repository with the task's
 * checkout, review comments served by a `gh` that talks to a file, and only the model mocked.
 *
 * What it shows that unit tests cannot: the triage is handed the task's checkout and the diff of the pull
 * request's branch (the user's own repository is on some other branch), the roadmap reaches the agent, what
 * the agent answers is made safe before anything acts on it, and a comment about a later phase is neither
 * answered nor settled until the user decides.
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

import { composeRevision, findLatestTriage } from '../src/cli/revision.ts';
import { decideScope } from '../src/initiatives/scope.ts';
import { withStore } from '../src/initiatives/store.ts';
import { loadRegistry, pullRequestKey } from '../src/tools/pr-registry.ts';
import type { FeedbackTriageReport } from '../src/utils/schemas.ts';
import { createFakeGh, type FakeGh } from './support/fake-gh.ts';
import { createWorkspaceRepo, deliverTask, type DeliveredTask, type WorkspaceRepo } from './support/git-repo.ts';

const ask = vi.mocked(invokeAgent);
const SAVED_ENV = { ...process.env };
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-feedback-e2e-'));

let mastra: typeof import('../src/mastra/index.ts')['mastra'];
let ws: WorkspaceRepo;
let logs: string;
let gh: FakeGh;
let uninstall: () => void;
let task: DeliveredTask;

beforeAll(async () => {
  process.env.FACTORY_LOG_DIR = path.join(home, 'logs');
  process.env.FACTORY_STORAGE_URL = `file:${path.join(home, 'logs', 'factory.db')}`;
  process.env.FACTORY_LOG_LEVEL = 'error';
  process.env.FACTORY_ENABLE_REPOMIX = 'false';
  ({ mastra } = await import('../src/mastra/index.ts'));
}, 60_000);
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in SAVED_ENV)) delete process.env[key];
  Object.assign(process.env, SAVED_ENV);
  fs.rmSync(home, { recursive: true, force: true });
});

const COMMENTS = [
  { id: 'IC_settings', author: { login: 'marc' }, body: 'Make the settings page dark too. It still has white cards.', createdAt: '2026-10-20T10:00:00Z' },
  { id: 'IC_question', author: { login: 'marc' }, body: 'Why did you export the greeting as a function and not a class?', createdAt: '2026-10-20T10:01:00Z' },
  { id: 'IC_shortcut', author: { login: 'marc' }, body: 'Could you add a keyboard shortcut for the theme toggle?', createdAt: '2026-10-20T10:02:00Z' },
];

const item = (commentId: string, overrides: Partial<FeedbackTriageReport['items'][number]>): FeedbackTriageReport['items'][number] => ({
  commentId, author: 'marc', excerpt: '', category: 'QUESTION', assignTo: 'none', reasoning: 'r', reply: '', filesInvolved: [], ...overrides,
});

/** What the model "says" about those three comments - including the mistakes the factory must not act on. */
const agentSays = (overrides: Partial<FeedbackTriageReport> = {}): FeedbackTriageReport => ({
  // Wrong on purpose: nothing here asks for a change to this pull request.
  overallAction: 'RERUN_IMPLEMENTATION',
  summary: 'One question, and two requests for later.',
  taskForNextRun: 'Make the settings page dark.',
  roundTitle: 'Dark settings page',
  blockers: ['Waiting for the user to decide where the later requests go'],
  items: [
    item('IC_settings', { excerpt: 'Make the settings page dark too', category: 'FUTURE_PHASE', assignTo: 'developer', targetPhase: 'i0001-p3', reply: 'That is the next phase.' }),
    item('IC_question', { excerpt: 'Why a function?', category: 'QUESTION', assignTo: 'none', reply: 'A function is enough: there is no state to keep.' }),
    item('IC_shortcut', { excerpt: 'keyboard shortcut', category: 'FUTURE_PHASE', assignTo: 'none', targetPhase: 'i0001-p9', reply: 'Later.' }),
  ],
  ...overrides,
});

beforeEach(async () => {
  ws = createWorkspaceRepo();
  logs = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-feedback-logs-'));
  vi.stubEnv('FACTORY_WORKSPACE_ROOT', ws.workspace);
  vi.stubEnv('FACTORY_LOG_DIR', logs);
  task = await deliverTask(ws);
  gh = createFakeGh({ headBranch: task.branch, headSha: task.headSha, comments: COMMENTS });
  uninstall = gh.install();
  ask.mockImplementation((async () => ({
    object: agentSays(), text: '', requestedModel: 'mock', servedByModel: 'mock', failedOver: false,
    usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, totalTokens: 2 }, toolCalls: 0, durationMs: 1, dryRun: false,
  })) as never);
});
afterEach(() => {
  ask.mockReset();
  uninstall();
  gh.cleanup();
  ws.cleanup();
  fs.rmSync(logs, { recursive: true, force: true });
});

async function triage(input: Record<string, unknown> = {}) {
  const run = await mastra.getWorkflow('prFeedbackWorkflow').createRun();
  const result = await run.start({ inputData: { repo: ws.repo, pullRequest: 8, postReplies: true, ...input } as never });
  if (result.status !== 'success') throw new Error(`triage ${result.status}: ${JSON.stringify((result as { error?: unknown }).error)}`);
  return result.result;
}
const agentCall = () => ask.mock.calls[0]![0] as unknown as { role: string; repoPath: string; prompt: string };
const posted = () => gh.calls().filter((call) => call[0] === 'pr' && call[1] === 'comment').map((call) => call[call.indexOf('--body') + 1]!);
const summaryOf = (runId: string) => JSON.parse(fs.readFileSync(path.join(logs, runId, 'summary.json'), 'utf8')) as Record<string, any>;

describe('the review of a phase of a project', () => {
  it('works on the task\'s checkout - the user\'s repository is on another branch and has none of this code', async () => {
    expect(ws.gitIn(ws.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(fs.existsSync(path.join(ws.repo, 'src', 'greeting.js'))).toBe(false);

    await triage();

    expect(agentCall()).toMatchObject({ role: 'feedback-triage', repoPath: task.workPath });
    // The diff the agent reads is the pull request's - which is only in the checkout.
    expect(agentCall().prompt).toContain('src/greeting.js');
    expect(agentCall().prompt).toContain('hello ${name}');
  });

  it('brings the checkout back if it was removed, and still sees the pull request\'s code', async () => {
    ws.gitIn(ws.repo, 'worktree', 'remove', task.workPath);
    expect(fs.existsSync(task.workPath)).toBe(false);

    await triage();

    expect(fs.existsSync(task.workPath)).toBe(true);
    expect(agentCall().repoPath).toBe(task.workPath);
    expect(agentCall().prompt).toContain('src/greeting.js');
  });

  it('gives the agent the roadmap, with the ids it must answer by', async () => {
    await triage();

    const prompt = agentCall().prompt;
    expect(prompt).toContain('## Roadmap');
    expect(prompt).toContain('This pull request is phase 1 of 3 of "Greetings"');
    expect(prompt).toContain('i0001-p1 - 1. Greeting helper [THIS PULL REQUEST]');
    expect(prompt).toContain('i0001-p3 - 3. Localise it [planned]');
  });

  it('makes what the agent said safe: a round for nothing but later-phase requests becomes a reply, and a made-up phase is "unknown"', async () => {
    const result = await triage();

    expect(result).toMatchObject({ action: 'REPLY_ONLY', followUpTask: '' });
    const comments = summaryOf(result.runId).comments as Array<Record<string, any>>;
    expect(comments.map((comment) => [comment.id, comment.category, comment.targetPhase])).toEqual([
      ['IC_settings', 'FUTURE_PHASE', 'i0001-p3'],
      ['IC_question', 'QUESTION', undefined],
      ['IC_shortcut', 'FUTURE_PHASE', null], // "i0001-p9" is no phase: the user will choose
    ]);
    expect(summaryOf(result.runId).status).toBe('REPLY_ONLY');
    expect(summaryOf(result.runId).roundTitle).toBeUndefined();
    // The trace keeps what the agent really answered, next to what was made of it.
    const artifact = JSON.parse(fs.readFileSync(path.join(logs, result.runId, '10-feedback-triage.json'), 'utf8'));
    expect(artifact.data.asAnswered.overallAction).toBe('RERUN_IMPLEMENTATION');
    expect(artifact.data.corrections.join(' ')).toContain('i0001-p9');
  });

  it('answers the question on GitHub, and says nothing about the later-phase requests until the user decides', async () => {
    const result = await triage();

    expect(result.repliesPosted).toBe(1);
    expect(posted()).toHaveLength(1);
    expect(posted()[0]).toContain('A function is enough');
    // The question is settled; the later-phase requests stay pending, waiting for a decision.
    expect(loadRegistry().pullRequests[pullRequestKey(ws.repo, 8)]!.handledCommentIds).toEqual(['IC_question']);
  });

  it('carries on to a decision: defer one, do the other now - and the round has exactly what was decided', async () => {
    const result = await triage();
    const latest = findLatestTriage(ws.repo, 8)!;
    expect(latest.runId).toBe(result.runId);

    await decideScope({
      repoPath: ws.repo, number: 8, comments: latest.comments,
      decisions: [{ commentId: 'IC_settings', decision: 'DEFER', targetPhase: 'i0001-p3' }, { commentId: 'IC_shortcut', decision: 'DO_NOW' }],
    });

    const phases = (await withStore((store) => store.getInitiative('i0001')))!.phases;
    expect(phases[2]!.notes).toMatchObject([{ source: 'user-request', text: expect.stringContaining('Make the settings page dark too') }]);

    const decisions = await withStore((store) => store.listScopeDecisions(pullRequestKey(ws.repo, 8)));
    const round = composeRevision({
      entry: loadRegistry().pullRequests[pullRequestKey(ws.repo, 8)]!,
      triage: latest,
      scopeDecisions: decisions.map((row) => ({ commentId: row.commentId, decision: row.decision })),
    });
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(round.revision.action).toBe('RERUN_PLANNING');
    expect(round.revision.comments.map((comment) => [comment.id, comment.category])).toEqual([['IC_shortcut', 'SCOPE_CHANGE']]);
    expect(round.task).toContain('keyboard shortcut for the theme toggle');
    expect(round.task).not.toContain('settings page');
  });

  it('does not triage again what was settled: the next triage sees only what is still pending', async () => {
    await triage();
    const latest = findLatestTriage(ws.repo, 8)!;
    await decideScope({ repoPath: ws.repo, number: 8, comments: latest.comments, decisions: [{ commentId: 'IC_settings', decision: 'DEFER', targetPhase: 'i0001-p3' }] });
    ask.mockClear();
    const handled = loadRegistry().pullRequests[pullRequestKey(ws.repo, 8)]!.handledCommentIds;
    expect(handled.sort()).toEqual(['IC_question', 'IC_settings']);

    await triage({ skipCommentIds: handled });

    const prompt = agentCall().prompt;
    expect(prompt).toContain('keyboard shortcut');
    expect(prompt).not.toContain('settings page dark');
    expect(prompt).not.toContain('Why did you export');
  });
});

describe('the review of a plain task - no later phase to defer to', () => {
  beforeEach(async () => {
    uninstall();
    gh.cleanup();
    ws.cleanup();
    ws = createWorkspaceRepo();
    vi.stubEnv('FACTORY_WORKSPACE_ROOT', ws.workspace);
    task = await deliverTask(ws, { phases: false });
    gh = createFakeGh({ headBranch: task.branch, headSha: task.headSha, comments: COMMENTS });
    uninstall = gh.install();
  });

  it('shows the agent no roadmap, and treats a "later phase" comment as new scope for this pull request', async () => {
    const result = await triage();

    expect(agentCall().prompt).not.toContain('## Roadmap');
    const comments = summaryOf(result.runId).comments as Array<Record<string, any>>;
    expect(comments.filter((comment) => comment.category === 'SCOPE_CHANGE').map((comment) => comment.id)).toEqual(['IC_settings', 'IC_shortcut']);
    expect(comments.some((comment) => comment.targetPhase !== undefined)).toBe(false);
    // The agent had asked for an implementation round; new scope needs the architect, but it is still a round.
    expect(result.action).toBe('RERUN_IMPLEMENTATION');
    expect(result.followUpTask).toBe('Make the settings page dark.');
  });
});
