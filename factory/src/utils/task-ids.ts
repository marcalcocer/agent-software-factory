/**
 * The id of a task: `f0042`, handed out in order, never twice.
 *
 * It is the handle that ties together everything one task leaves behind - the branch
 * (`factory/f0042/feat-...`), the commit trailer, the run and its rounds - so it must not collide, even
 * when two runs start in the same second. A counter in the log directory, under a lock.
 *
 * A counter and not a random suffix: people say "f0042", and the order tells which came first.
 */
import fs from 'node:fs';
import path from 'node:path';

import { formatTaskId } from '../tools/run-naming.ts';
import { getFactoryConfig } from './factory-config.ts';
import { withFileLock } from './file-lock.ts';

const sequenceFile = (): string => path.join(getFactoryConfig().logDir, 'task-sequence.json');

/** Reserves the next id. */
export async function allocateTaskId(): Promise<string> {
  const file = sequenceFile();
  return await withFileLock(`${file}.lock`, () => {
    let last = 0;
    try {
      last = Number((JSON.parse(fs.readFileSync(file, 'utf8')) as { last?: unknown }).last) || 0;
    } catch {
      // Missing or torn: start from the beginning rather than refuse to run.
    }
    const next = last + 1;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ last: next })}\n`, 'utf8');
    fs.renameSync(temp, file);
    return formatTaskId(next);
  });
}
