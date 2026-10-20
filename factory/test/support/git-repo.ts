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

/* -------------------------------------------------------------------------- */
/* A repository inside a workspace, with a remote                              */
/* -------------------------------------------------------------------------- */

export interface WorkspaceRepo {
  /** `FACTORY_WORKSPACE_ROOT`: the repository is `<workspace>/app`, and the factory's checkouts go under `<workspace>/.factory`. */
  workspace: string;
  repo: string;
  /** The bare repository `origin` points at. */
  remote: string;
  /** Runs git in the repository. */
  git: (...args: string[]) => string;
  /** Runs git anywhere. */
  gitIn: (cwd: string, ...args: string[]) => string;
  /** Pushes a commit to `origin` from a clone of its own, as a teammate (or a reviewer) would. */
  pushFromElsewhere: (branch: string, file: string, content: string) => void;
  cleanup: () => void;
}

const LOCK_WITHOUT_DEPENDENCIES = JSON.stringify(
  { name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'app', version: '1.0.0' } } },
  null,
  2,
);

/**
 * A small JavaScript project on `main`, pushed to a bare `origin`, with a `node_modules` that git
 * ignores - the shape a real repository has when a task starts.
 */
export function createWorkspaceRepo(): WorkspaceRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-workspace-'));
  const workspace = path.join(root, 'workspace');
  const repo = path.join(workspace, 'app');
  const remote = path.join(root, 'origin.git');
  fs.mkdirSync(repo, { recursive: true });

  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).toString();
  const git = (...args: string[]) => gitIn(repo, ...args);
  const identify = (cwd: string) => {
    gitIn(cwd, 'config', 'user.email', 'test@example.com');
    gitIn(cwd, 'config', 'user.name', 'Test');
  };

  gitIn(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git('init', '-q', '-b', 'main');
  identify(repo);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
  fs.writeFileSync(path.join(repo, 'src', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
  fs.writeFileSync(path.join(repo, 'package-lock.json'), LOCK_WITHOUT_DEPENDENCIES);
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');

  // Installed dependencies: untracked, and ignored.
  fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = "dep";\n');

  const pushFromElsewhere = (branch: string, file: string, content: string) => {
    const clone = fs.mkdtempSync(path.join(root, 'clone-'));
    gitIn(root, 'clone', '-q', remote, clone);
    identify(clone);
    try {
      gitIn(clone, 'checkout', '-q', branch);
    } catch {
      gitIn(clone, 'checkout', '-q', '-b', branch);
    }
    fs.mkdirSync(path.dirname(path.join(clone, file)), { recursive: true });
    fs.writeFileSync(path.join(clone, file), content);
    gitIn(clone, 'add', '-A');
    gitIn(clone, 'commit', '-q', '-m', `add ${file}`);
    gitIn(clone, 'push', '-q', 'origin', branch);
  };

  return { workspace, repo, remote, git, gitIn, pushFromElsewhere, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
