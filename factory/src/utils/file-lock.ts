/**
 * A lock between processes, for the few files several factory processes may write at the same time
 * (the pull-request registry, the task-id sequence).
 *
 * `mkdir` is atomic, which is all a lock needs: whoever creates the directory holds the lock. A
 * holder that crashed does not block anyone for ever (the lock goes stale), and a waiter that has
 * waited long enough goes ahead without it - bookkeeping must not be the reason a delivery fails.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface FileLockOptions {
  /** A lock older than this is taken to belong to a process that died. */
  staleMs?: number;
  /** How long to wait for the lock before going ahead without it. */
  waitMs?: number;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_WAIT_MS = 3_000;

/** Runs `fn` while holding the lock `lockDir`. */
export async function withFileLock<T>(lockDir: string, fn: () => T, options: FileLockOptions = {}): Promise<T> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const startedWaiting = Date.now();

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        // A crashed writer must not block everyone for ever.
        if (Date.now() - fs.statSync(lockDir).mtimeMs > staleMs) fs.rmSync(lockDir, { recursive: true });
      } catch {
        // Someone else released it in the meantime.
      }
      if (Date.now() - startedWaiting > waitMs) {
        // Proceeding unlocked beats failing a delivery over bookkeeping.
        return fn();
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
