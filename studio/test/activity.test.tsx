// @vitest-environment jsdom
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { activityForNode, currentActivity, groupCalls } from '../shared/activity';
import type { ActivityEntry, RunArtifact } from '../shared/types';
import { readRunActivity } from '../electron/services/run-state';
import { AgentDetail } from '../src/components/AgentDetail';

let n = 0;
const at = () => new Date(Date.UTC(2026, 9, 24, 16, 0, n++)).toISOString();
const entry = (over: Partial<ActivityEntry>): ActivityEntry => ({
  at: at(),
  call: 'developer#1#1',
  role: 'developer',
  step: 'developer',
  attempt: 1,
  kind: 'text',
  text: '',
  ...over,
});

/** A developer call as the factory writes it: start, a streamed paragraph, two tools, a failed tool, the report. */
const developerCall = (attempt = 1): ActivityEntry[] => {
  const call = `developer#${attempt}#1`;
  const base = { call, attempt };
  return [
    entry({ ...base, kind: 'call-start', text: 'Asking Claude (sonnet)', model: 'claude-cli/sonnet', backend: 'claude-cli' }),
    entry({ ...base, kind: 'thinking', text: 'Thought it through (~240 tokens)' }),
    entry({ ...base, kind: 'text', text: "I'll start by reading ", block: `${call}:m1b1` }),
    entry({ ...base, kind: 'text', text: 'the theme module.', block: `${call}:m1b1` }),
    entry({ ...base, kind: 'tool', text: 'Reading src/theme.ts', tool: 'Read' }),
    entry({ ...base, kind: 'tool-error', text: 'File does not exist.' }),
    entry({ ...base, kind: 'tool', text: 'Editing src/Button.tsx', tool: 'Edit' }),
  ];
};

describe('activity of a run, read from disk', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads new lines only, and leaves a line still being written for the next read', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-read-'));
    const file = path.join(dir, 'activity.ndjson');
    const [a, b, c] = developerCall();
    fs.writeFileSync(file, `${JSON.stringify(a)}\n${JSON.stringify(b)}\n${JSON.stringify(c).slice(0, 20)}`);

    const first = readRunActivity(dir);
    expect(first.entries.map((e) => e.kind)).toEqual(['call-start', 'thinking']);
    expect(first.total).toBe(2);

    fs.writeFileSync(file, `${JSON.stringify(a)}\n${JSON.stringify(b)}\n${JSON.stringify(c)}\n`);
    const next = readRunActivity(dir, first.total);
    expect(next.entries.map((e) => e.kind)).toEqual(['text']);
    expect(next.total).toBe(3);
  });

  it('is empty for a run that has none', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-read-'));
    expect(readRunActivity(dir)).toEqual({ entries: [], total: 0 });
  });
});

describe('activity shaped for the views', () => {
  it('joins the streamed pieces of a paragraph and keeps everything else in order', () => {
    const [call] = groupCalls(developerCall());
    expect(call).toMatchObject({ model: 'claude-cli/sonnet', backend: 'claude-cli', status: 'running' });
    expect(call!.items.map((i) => [i.kind, i.text])).toEqual([
      ['call-start', 'Asking Claude (sonnet)'],
      ['thinking', 'Thought it through (~240 tokens)'],
      ['text', "I'll start by reading the theme module."],
      ['tool', 'Reading src/theme.ts'],
      ['tool-error', 'File does not exist.'],
      ['tool', 'Editing src/Button.tsx'],
    ]);
  });

  it('marks a call done or failed, with its model, duration and tokens', () => {
    const done = groupCalls([
      ...developerCall(),
      entry({ kind: 'call-end', text: 'Answered', model: 'claude-sonnet-4-6', durationMs: 12_300, tokens: 5400 }),
    ])[0]!;
    expect(done).toMatchObject({ status: 'done', model: 'claude-sonnet-4-6', durationMs: 12_300, tokens: 5400 });
    const failed = groupCalls([...developerCall(), entry({ kind: 'call-failed', text: 'usage limit' })])[0]!;
    expect(failed.status).toBe('failed');
  });

  it('gives each pipeline step its own activity, by step and attempt, never mixing steps that run together', () => {
    const all = [
      ...developerCall(1),
      ...developerCall(2),
      entry({ call: 'code-review#1#1', role: 'reviewer', step: 'code-review', kind: 'tool', text: 'Reading src/a.ts' }),
      entry({ call: 'security#1#1', role: 'security', step: 'security', kind: 'tool', text: 'Searching for "password"' }),
      entry({ call: 'code-review#2#1', role: 'reviewer', step: 'code-review', attempt: 2, kind: 'tool', text: 'Reading src/b.ts' }),
    ];
    expect(new Set(activityForNode(all, { artifactStep: 'developer', attempt: 2 }).map((e) => e.attempt))).toEqual(new Set([2]));
    // The review node is the reviewer's, whatever the artifact step is called, across its attempts.
    expect(activityForNode(all, { artifactStep: 'reviewer', attempt: 1 }).map((e) => e.text)).toEqual(['Reading src/a.ts', 'Reading src/b.ts']);
    expect(activityForNode(all, { artifactStep: 'security', attempt: 1 }).map((e) => e.text)).toEqual(['Searching for "password"']);
    expect(activityForNode(all, undefined)).toEqual([]);
  });

  it('says in one line what a step is doing right now', () => {
    expect(currentActivity(developerCall())).toBe('Editing src/Button.tsx');
    expect(currentActivity(developerCall().slice(0, 4))).toBe("“I'll start by reading the theme module.”");
    expect(currentActivity([])).toBeNull();
  });
});

describe('the step view', () => {
  const runningNode = { id: 'developer-1', name: 'Dev 1', icon: '💻', status: 'running' as const, attempt: 1, kind: 'step' as const, artifactStep: 'developer' };

  it('follows a running step live: model, what it said, each tool, a failed tool', () => {
    render(<AgentDetail step="developer-1" node={runningNode} isRunning activity={developerCall()} />);
    const feed = screen.getByTestId('activity-feed');
    expect(feed.textContent).toContain('sonnet');
    expect(feed.textContent).toContain('working');
    expect(feed.textContent).toContain("I'll start by reading the theme module.");
    expect(feed.textContent).toContain('Reading src/theme.ts');
    expect(feed.textContent).toContain('File does not exist.');
    expect(feed.textContent).toContain('Editing src/Button.tsx');
    expect(screen.queryByText('Waiting for output...')).toBeNull();
  });

  it('keeps how the agent got there under a finished report', async () => {
    const artifact: RunArtifact = { step: 'developer', attempt: 1, status: 'COMPLETED', model: 'claude-sonnet-4-6', data: { summary: 'Done.' } };
    const activity = [...developerCall(), entry({ kind: 'call-end', text: 'Answered', model: 'claude-sonnet-4-6', durationMs: 5000 })];
    render(<AgentDetail step="developer-1" node={{ ...runningNode, status: 'completed' }} artifact={artifact} activity={activity} />);
    const summary = screen.getByText(/What the agent did \(2 tool calls\)/);
    await act(async () => {
      await userEvent.setup().click(summary);
    });
    expect(screen.getByTestId('activity-feed').textContent).toContain('done in 5.0s');
  });

  it('falls back to the console lines for a run from before activity was recorded', () => {
    render(<AgentDetail step="developer-1" node={runningNode} isRunning logs={['Agent "developer" started']} activity={[]} />);
    expect(screen.queryByTestId('activity-feed')).toBeNull();
    expect(screen.getByText(/Agent "developer" started/)).toBeTruthy();
  });
});

describe('the pipeline of a live run', () => {
  it('shows under each running step what its agent is doing now, and follows it live on request', async () => {
    const { RUN } = await import('../../fixtures');
    const { PipelineView } = await import('../src/components/PipelineView');
    const { installFakeApi, openingARun } = await import('./support/fake-api');
    // Whatever step the live run is on, its agent is reading a file.
    const steps = ['run-namer', 'pm-architect', 'developer', 'qa-tester', 'triage', 'code-review', 'security', 'polish', 'documentation', 'pr-writer'];
    const live = steps.flatMap((step) =>
      [1, 2, 3].map((attempt) =>
        entry({ call: `${step}#${attempt}#1`, role: step, step, attempt, kind: 'tool', text: `Reading src/${step}.ts`, tool: 'Read' }),
      ),
    );
    const api = installFakeApi({ ...openingARun([RUN.smokeEscalated], [RUN.smokeEscalated]), 'factory:get-activity': () => ({ entries: live, total: live.length }) });

    render(<PipelineView runId={RUN.smokeEscalated} isRunning />);

    const now = await screen.findAllByTestId('now-doing');
    expect(now[0]!.textContent).toBe('Reading src/developer.ts'); // developer-3 is the step running
    await act(async () => {
      await userEvent.setup().click(screen.getAllByText('Follow live')[0]!);
    });
    expect(screen.getByTestId('activity-feed').textContent).toContain('Reading src/');
    // Polled incrementally: after the first read, the next asks only for what follows.
    expect(api.callsTo('factory:get-activity')[0]).toEqual([RUN.smokeEscalated, undefined]);
  });
});
