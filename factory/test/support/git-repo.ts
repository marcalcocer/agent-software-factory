import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BIG_CHANGE_FILES = 40;

const body = (file: number, version: string): string =>
  Array.from({ length: 40 }, (_, line) => `export const value${file}_${line} = '${version}-${'x'.repeat(24)}';`).join('\n') + '\n';

/**
 * A real git repository holding a change larger than the process output cap (24,000 characters):
 * forty files rewritten, plus one that is not tracked yet. That cap used to apply to `git diff` too,
 * and cut it in the middle without a word.
 */
export function createBigChangeRepo(): { repo: string; git: (...args: string[]) => string; cleanup: () => void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-big-change-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(repo, 'src'));
  const name = (i: number) => path.join(repo, 'src', `file${String(i).padStart(2, '0')}.ts`);
  for (let i = 0; i < BIG_CHANGE_FILES; i += 1) fs.writeFileSync(name(i), body(i, 'before'));
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');

  for (let i = 0; i < BIG_CHANGE_FILES; i += 1) fs.writeFileSync(name(i), body(i, 'after'));
  fs.writeFileSync(path.join(repo, 'src', 'brand-new.ts'), 'export const fresh = true;\n');

  return { repo, git, cleanup: () => fs.rmSync(repo, { recursive: true, force: true }) };
}
