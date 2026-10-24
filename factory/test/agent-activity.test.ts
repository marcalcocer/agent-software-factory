import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../src/utils/claude-cli.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/claude-cli.ts')>()),
  runClaudeCli: vi.fn(),
}));

import {
  ActivityRecorder,
  ClaudeStreamParser,
  describeToolUse,
  readActivity,
  type ActivityEntry,
} from '../src/utils/agent-activity.ts';
import { invokeAgent } from '../src/utils/agent-runner.ts';
import { runClaudeCli } from '../src/utils/claude-cli.ts';
import { readEvents, traceDirFor } from '../src/tools/logger-tools.ts';

const FIXTURES = path.join(import.meta.dirname, '..', '..', 'fixtures', 'claude-stream');
const REPO = '/home/dev/workspace/demo';
const transcript = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

let dir: string;
let runN = 0;
const nextRun = () => `activity-test-${process.pid}-${++runN}`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-'));
  vi.stubEnv('FACTORY_LOG_DIR', dir);
  vi.mocked(runClaudeCli).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Feeds a transcript the way stdout delivers it: in chunks that cut lines anywhere. */
function replay(text: string, parser: ClaudeStreamParser, seed = 7): void {
  let i = 0;
  let n = seed;
  while (i < text.length) {
    n = (n * 9301 + 49297) % 233280;
    const size = 1 + (n % 700);
    parser.push(text.slice(i, i + size));
    i += size;
  }
  parser.end();
}

function parse(name: string): ActivityEntry[] {
  const runId = nextRun();
  const recorder = new ActivityRecorder({ runId, role: 'reviewer', step: 'code-review', attempt: 2, cwd: REPO, echo: false });
  replay(transcript(name), new ClaudeStreamParser(recorder));
  return readActivity(traceDirFor(runId));
}

/** Text entries of one paragraph, joined back together. */
const paragraphs = (entries: ActivityEntry[]) => {
  const out: string[] = [];
  let last: string | undefined;
  for (const entry of entries.filter((e) => e.kind === 'text')) {
    if (entry.block && entry.block === last) out[out.length - 1] += entry.text;
    else out.push(entry.text);
    last = entry.block;
  }
  return out;
};

describe('the Claude Code stream, as recorded', () => {
  it('shows what the model says, what it reads and when it writes its report, in order', () => {
    const entries = parse('read-and-report.ndjson');
    expect(entries.every((e) => e.step === 'code-review' && e.attempt === 2 && e.role === 'reviewer')).toBe(true);
    expect(new Set(entries.map((e) => e.call)).size).toBe(1);

    // Consecutive text entries are one paragraph streamed in pieces.
    const kinds = entries.map((e) => e.kind).filter((kind, i, all) => kind !== 'text' || all[i - 1] !== 'text');
    expect(kinds).toEqual(['thinking', 'text', 'tool', 'text', 'summary', 'thinking', 'report']);
    expect(paragraphs(entries)).toEqual([
      "I'll read `math.ts` from the working directory and summarise what it exports and does.",
      '`math.ts` is a one-line module. It exports a single function, `add`, which takes two numbers and returns their sum. It has no other exports, imports, or logic.',
    ]);
    expect(entries.find((e) => e.kind === 'tool')).toMatchObject({ text: 'Reading math.ts', tool: 'Read' });
    expect(entries.find((e) => e.kind === 'thinking')!.text).toBe('Thought it through (~240 tokens)');
    expect(entries.find((e) => e.kind === 'report')!.text).toBe('Writing the final report');
    expect(entries.find((e) => e.kind === 'summary')!.text).toContain('math.ts exports one function');
  });

  it('reports a tool that failed, with its reason, and a search in words', () => {
    const entries = parse('tool-error-and-search.ndjson');
    const visible = entries.filter((e) => e.kind !== 'text' && e.kind !== 'thinking' && e.kind !== 'summary');
    expect(visible.map((e) => [e.kind, e.text])).toEqual([
      ['tool', 'Reading missing.ts'],
      ['tool-error', expect.stringContaining('File does not exist')],
      ['tool', 'Searching for "add"'],
      ['report', 'Writing the final report'],
    ]);
  });

  it('gives the same result however the stream is cut', () => {
    const a = parse('read-and-report.ndjson').map((e) => [e.kind, e.text]);
    const runId = nextRun();
    const recorder = new ActivityRecorder({ runId, role: 'reviewer', step: 'code-review', attempt: 2, cwd: REPO, echo: false });
    const parser = new ClaudeStreamParser(recorder);
    replay(transcript('read-and-report.ndjson'), parser, 12345);
    const b = readActivity(traceDirFor(runId)).map((e) => [e.kind, e.text]);
    expect(paragraphs(b.map(([kind, text]) => ({ kind, text }) as ActivityEntry)).join('')).toBe(
      paragraphs(a.map(([kind, text]) => ({ kind, text }) as ActivityEntry)).join(''),
    );
    expect(b.filter(([kind]) => kind !== 'text')).toEqual(a.filter(([kind]) => kind !== 'text'));
  });

  it('skips lines that are not JSON or not known, without failing', () => {
    const runId = nextRun();
    const recorder = new ActivityRecorder({ runId, role: 'qa-tester', step: 'qa-tester', attempt: 1, cwd: REPO, echo: false });
    const parser = new ClaudeStreamParser(recorder);
    parser.push('not json\n{"type":"mystery"}\n{"type":"stream_event","event":null}\n{broken\n');
    parser.end();
    expect(readActivity(traceDirFor(runId))).toEqual([]);
  });
});

describe('streamed text', () => {
  it('is gathered into readable pieces, not one entry per word', () => {
    const runId = nextRun();
    const recorder = new ActivityRecorder({ runId, role: 'developer', step: 'developer', attempt: 1, cwd: REPO, echo: false });
    for (const word of 'Now I will change the button so that it reads its colour from the theme instead of a constant.'.split(' ')) {
      recorder.text('b0', `${word} `);
    }
    recorder.text('b0', 'Then the tests.\nSecond line');
    recorder.close();
    const entries = readActivity(traceDirFor(runId));
    expect(entries.length).toBeLessThanOrEqual(3);
    expect(entries.map((e) => e.text).join('')).toBe(
      'Now I will change the button so that it reads its colour from the theme instead of a constant. Then the tests.\nSecond line',
    );
    expect(new Set(entries.map((e) => e.block)).size).toBe(1);
  });

  it('shows a sentence that stops mid-way within half a second', () => {
    vi.useFakeTimers();
    const runId = nextRun();
    const recorder = new ActivityRecorder({ runId, role: 'developer', step: 'developer', attempt: 1, cwd: REPO, echo: false });
    recorder.text('b0', 'Looking at the');
    expect(readActivity(traceDirFor(runId))).toEqual([]);
    vi.advanceTimersByTime(900);
    expect(readActivity(traceDirFor(runId)).map((e) => e.text)).toEqual(['Looking at the']);
    recorder.close();
  });
});

describe('tool calls in words', () => {
  it('names the file, the search and the edit, relative to the repository', () => {
    expect(describeToolUse('Read', { file_path: `${REPO}/src/app.ts`, offset: 40, limit: 20 }, REPO)).toBe('Reading src/app.ts (from line 40, 20 lines)');
    expect(describeToolUse('Grep', { pattern: 'useTheme', path: `${REPO}/src`, glob: '*.tsx' }, REPO)).toBe('Searching for "useTheme" in src (*.tsx)');
    expect(describeToolUse('Glob', { pattern: '**/*.test.ts' }, REPO)).toBe('Listing files matching **/*.test.ts');
    expect(describeToolUse('Edit', { file_path: `${REPO}/src/app.ts` }, REPO)).toBe('Editing src/app.ts');
    expect(describeToolUse('Write', { file_path: '/elsewhere/x.md' }, REPO)).toBe('Writing /elsewhere/x.md');
    expect(describeToolUse('StructuredOutput', {}, REPO)).toBe('Writing the final report');
    expect(describeToolUse('read-file', { path: `${REPO}/README.md` }, REPO)).toBe('read-file README.md');
  });
});

describe('an agent call', () => {
  const schema = z.object({ summary: z.string(), files: z.array(z.string()) });
  const agent = { getInstructions: async () => 'Read and report.' } as never;

  it('records its start, everything it did, and its end, under its own step and attempt', async () => {
    vi.stubEnv('FACTORY_PROVIDER', 'claude-cli');
    vi.stubEnv('FACTORY_FREE_ROLES', '');
    const text = transcript('read-and-report.ndjson');
    vi.mocked(runClaudeCli).mockImplementation(async (request) => {
      for (let i = 0; i < text.length; i += 333) request.onStdout?.(text.slice(i, i + 333));
      return {
        ok: true,
        structuredOutput: { summary: 'adds', files: ['math.ts'] },
        text: '',
        servedByModel: 'claude-haiku-4-5',
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, totalTokens: 2 },
        toolCalls: 1,
        durationMs: 1,
        sessionId: 's',
        costUsd: 0,
      };
    });
    const runId = nextRun();
    await invokeAgent({
      agent,
      role: 'qa-tester',
      step: 'qa-tester',
      attempt: 2,
      runId,
      repoPath: REPO,
      prompt: 'Go.',
      schema,
      dryRunResult: { summary: '', files: [] },
    });
    const entries = readActivity(traceDirFor(runId));
    expect(entries[0]).toMatchObject({ kind: 'call-start', step: 'qa-tester', attempt: 2, backend: 'claude-cli' });
    expect(entries.at(-1)).toMatchObject({ kind: 'call-end', model: 'claude-haiku-4-5', tokens: 2 });
    expect(entries.map((e) => e.kind)).toContain('tool');
    expect(entries.map((e) => e.kind)).toContain('report');
  });

  it('records a failure, with the reason', async () => {
    vi.stubEnv('FACTORY_PROVIDER', 'claude-cli');
    vi.mocked(runClaudeCli).mockResolvedValue({
      ok: false,
      structuredOutput: undefined,
      text: '',
      servedByModel: 'unknown',
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, totalTokens: 0 },
      toolCalls: 0,
      durationMs: 1,
      sessionId: '',
      costUsd: 0,
      error: 'Claude subscription usage limit reached.',
      errorKind: 'rate-limit',
      usageLimit: { resetsAt: '2026-10-24T17:20:00.000Z', window: 'five_hour' },
    });
    const runId = nextRun();
    await expect(
      invokeAgent({ agent, role: 'qa-tester', step: 'qa-tester', runId, repoPath: REPO, prompt: 'Go.', schema, dryRunResult: { summary: '', files: [] } }),
    ).rejects.toThrow();
    const last = readActivity(traceDirFor(runId)).at(-1)!;
    expect(last.kind).toBe('call-failed');
    expect(last.text).toContain("Claude's 5-hour limit is used up: it resets at");
    // What lets the Studio retry the run when the limit is back.
    expect(readEvents(runId).find((e) => e.type === 'usage_limit')).toMatchObject({
      role: 'qa-tester',
      step: 'qa-tester',
      resetsAt: '2026-10-24T17:20:00.000Z',
      window: 'five_hour',
    });
  });
});
