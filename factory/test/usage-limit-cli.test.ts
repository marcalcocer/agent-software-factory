import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runClaudeCli } from '../src/utils/claude-cli.ts';

/**
 * A stand-in for the `claude` binary: prints a refused call the way Claude Code does (a
 * `rate_limit_event`, then an error result) and exits 1.
 */
function fakeClaude(dir: string, result: string, withEvent = true): void {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', cwd: dir }),
    ...(withEvent
      ? [JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792862400, rateLimitType: 'five_hour' } })]
      : []),
    JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result, num_turns: 1 }),
  ];
  const out = path.join(dir, 'stream.ndjson');
  fs.writeFileSync(out, `${lines.join('\n')}\n`);
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\ncat "${out}"\nexit 1\n`);
  fs.chmodSync(bin, 0o755);
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH ?? ''}`);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const call = () => runClaudeCli({ systemPrompt: 's', prompt: 'p', model: 'haiku', cwd: dir, timeoutMs: 20_000 });

describe('a call refused for the usage limit', () => {
  it('is a rate-limit failure that says which window and when it resets', async () => {
    fakeClaude(dir, "You've hit your limit · resets 7:20pm");
    const response = await call();
    expect(response.ok).toBe(false);
    expect(response.errorKind).toBe('rate-limit');
    expect(response.usageLimit).toEqual({ resetsAt: '2026-10-24T17:20:00.000Z', window: 'five_hour' });
    expect(response.error).toContain('5-hour limit; resets at 2026-10-24T17:20:00.000Z');
  });

  it('is recognised from the stream even when the error text does not name the limit', async () => {
    fakeClaude(dir, 'Request was refused.');
    const response = await call();
    expect(response.errorKind).toBe('rate-limit');
    expect(response.usageLimit?.resetsAt).toBe('2026-10-24T17:20:00.000Z');
  });

  it('falls back to the time in the error text when the stream has no limit event', async () => {
    fakeClaude(dir, 'Claude AI usage limit reached|1792866000', false);
    const response = await call();
    expect(response.errorKind).toBe('rate-limit');
    expect(response.usageLimit).toEqual({ resetsAt: '2026-10-24T18:20:00.000Z' });
  });

  it('leaves other failures alone', async () => {
    fakeClaude(dir, 'Something broke.', false);
    const response = await call();
    expect(response.errorKind).not.toBe('rate-limit');
    expect(response.usageLimit).toBeUndefined();
  });
});
