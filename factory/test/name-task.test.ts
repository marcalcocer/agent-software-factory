import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN, readJson } from '../../fixtures';

// `invokeAgent` is the only way to a model; everything else in the workflow module is the real code.
vi.mock('../src/utils/agent-runner.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/agent-runner.ts')>()),
  invokeAgent: vi.fn(),
}));

import { invokeAgent } from '../src/utils/agent-runner.ts';
import { readEvents } from '../src/tools/logger-tools.ts';
import { nameTask } from '../src/workflows/software-factory.workflow.ts';

const ask = vi.mocked(invokeAgent);
const REAL_TASK = readJson(RUN.round1, 'run.json').task as string;

let logs: string;
beforeEach(() => {
  logs = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-name-task-'));
  vi.stubEnv('FACTORY_LOG_DIR', logs);
});
afterEach(() => {
  ask.mockReset();
  fs.rmSync(logs, { recursive: true, force: true });
});

const run = { runId: 'r1', repoPath: '/w/repo', repoName: 'repo' };
const artifact = () => JSON.parse(fs.readFileSync(path.join(logs, 'r1', '00-run-namer.json'), 'utf8'));
const answer = (object: unknown) =>
  ask.mockResolvedValue({ object, servedByModel: 'claude-haiku-5-5', usage: { totalTokens: 15_000 } } as never);

describe('nameTask when the AI answers', () => {
  it('names the task from the answer, cleaned, and records it', async () => {
    answer({ title: '  "professional redesign of the frontend."  ', slug: 'Professional Frontend Redesign!', type: 'feat' });

    const { name, source } = await nameTask(run, REAL_TASK, undefined);

    expect(source).toBe('agent');
    expect(name).toEqual({ title: 'Professional redesign of the frontend', slug: 'professional-frontend-redesign', type: 'feat' });
    expect(artifact()).toMatchObject({ status: 'COMPLETED', model: 'claude-haiku-5-5', data: name });
  });

  it('asks the cheapest way: a short timeout, two attempts at most, and only the request in the prompt', async () => {
    answer({ title: 'Dark mode', slug: 'dark-mode', type: 'feat' });
    await nameTask(run, 'x'.repeat(10_000), undefined);

    const call = ask.mock.calls[0]![0];
    expect(call).toMatchObject({ role: 'run-namer', timeoutMs: 45_000, maxRungs: 2 });
    expect(call.prompt.length).toBeLessThan(4_300); // the request is cut: the rest only costs tokens
    expect(call.prompt).toContain('the request goes on');
  });
});

describe('nameTask when the AI cannot answer', () => {
  // The real error the CLI gave while this was being written: the subscription session had expired.
  const EXPIRED = 'Agent "run-namer" failed during step "run-namer" [claude-cli/auth]: Claude Code is not authenticated (OAuth session expired). Run `claude login` and retry.';

  it('names the task from the request instead of failing the run, and says so', async () => {
    ask.mockRejectedValue(new Error(EXPIRED));
    const warnings: string[] = [];

    const { name, source } = await nameTask(run, REAL_TASK, { warn: (message: string) => warnings.push(message) });

    expect(source).toBe('fallback');
    expect(name).toEqual({ title: 'Big refactor on the UI for this repository', slug: 'big-refactor-on-the-ui-for-this', type: 'refactor' });
    expect(artifact()).toMatchObject({ status: 'FALLBACK', data: { ...name, error: expect.stringContaining('OAuth session expired') } });
    expect(readEvents('r1').map((event) => event.type)).toEqual(['run_naming', 'step_artifact', 'run_namer_fallback']);
    expect(warnings[0]).toContain('named from the request instead');
  });

  it('does the same for a timeout and for an answer that never fits the contract', async () => {
    for (const message of ['Claude Code did not answer within the timeout.', 'returned output violating its schema on all 2 attempts']) {
      ask.mockRejectedValue(new Error(message));
      expect((await nameTask(run, 'Fix the token refresh race', undefined)).source).toBe('fallback');
    }
  });

  it('uses the stand-in for whatever part of a half-usable answer is missing', async () => {
    answer({ title: 'Token refresh race', slug: '', type: 'nonsense' });

    const { name, source } = await nameTask(run, 'Fix the token refresh race condition on concurrent requests', undefined);

    expect(source).toBe('agent');
    expect(name).toEqual({ title: 'Token refresh race', slug: 'token-refresh-race', type: 'fix' });
  });
});
