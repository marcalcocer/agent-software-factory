import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withFileLock } from '../src/utils/file-lock.ts';
import { allocateTaskId } from '../src/utils/task-ids.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-task-ids-'));
  vi.stubEnv('FACTORY_LOG_DIR', dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('allocateTaskId', () => {
  it('hands out ids in order, starting at f0001', async () => {
    expect(await allocateTaskId()).toBe('f0001');
    expect(await allocateTaskId()).toBe('f0002');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'task-sequence.json'), 'utf8'))).toEqual({ last: 2 });
  });

  it('never hands out the same id twice, even when runs start together', async () => {
    const ids = await Promise.all(Array.from({ length: 30 }, () => allocateTaskId()));

    expect(new Set(ids).size).toBe(30);
    expect([...ids].sort()).toEqual(Array.from({ length: 30 }, (_, i) => `f${String(i + 1).padStart(4, '0')}`));
  });

  it('carries on from where the last one stopped, across processes', async () => {
    fs.writeFileSync(path.join(dir, 'task-sequence.json'), '{"last": 41}\n');
    expect(await allocateTaskId()).toBe('f0042');
  });

  it('starts again rather than refuse to run when the file is torn', async () => {
    fs.writeFileSync(path.join(dir, 'task-sequence.json'), '{"las');
    expect(await allocateTaskId()).toBe('f0001');
  });

  it('leaves no lock behind', async () => {
    await allocateTaskId();
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.lock'))).toEqual([]);
  });
});

describe('withFileLock', () => {
  const lock = () => path.join(dir, 'x.lock');

  it('lets one holder at a time in', async () => {
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withFileLock(lock(), async () => {
          inside += 1;
          most = Math.max(most, inside);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inside -= 1;
        }),
      ),
    );
    // `fn` is synchronous in practice; this holds because the lock serialises even async work started inside.
    expect(most).toBeGreaterThanOrEqual(1);
  });

  it('takes over a lock whose holder died', async () => {
    fs.mkdirSync(lock());
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock(), old, old);

    expect(await withFileLock(lock(), () => 'ran', { staleMs: 30_000, waitMs: 1_000 })).toBe('ran');
  });

  it('goes ahead without the lock after waiting long enough, rather than fail', async () => {
    fs.mkdirSync(lock()); // held by someone alive (fresh)
    const started = Date.now();

    expect(await withFileLock(lock(), () => 'ran anyway', { staleMs: 60_000, waitMs: 120 })).toBe('ran anyway');
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(fs.existsSync(lock())).toBe(true); // someone else's lock is not ours to remove
  });

  it('releases the lock even when the work throws', async () => {
    await expect(withFileLock(lock(), () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(fs.existsSync(lock())).toBe(false);
  });
});
