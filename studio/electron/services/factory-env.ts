/**
 * What the Studio tells the factory processes it starts, beyond the environment the Studio itself was started with.
 *
 * The factory works only in the places it is allowed to: the workspace, the folder of its checkouts, and the
 * repositories opened on purpose. It never trusts a path because it was passed to `--repo` - so the Studio, where the
 * user opens repositories (the folder picker takes any folder), says which ones are. Without that, a repository
 * outside the workspace could be added in the Studio and then refused by the factory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface KnownRepository {
  name: string;
  path: string;
  /** How many runs were made on it (the records in the logs folder). */
  recentRuns: number;
}

/**
 * The repositories the Studio lists: the ones the user added, then the ones runs were made on. The factory is told
 * the same list it may work on - what the user can see and click is what they opened.
 */
export function knownRepositories(input: {
  saved?: ReadonlyArray<{ name: string; path: string }> | undefined;
  logsDir: string;
}): KnownRepository[] {
  const repos = new Map<string, KnownRepository>();
  for (const saved of input.saved ?? []) repos.set(saved.name, { name: saved.name, path: saved.path, recentRuns: 0 });

  if (fs.existsSync(input.logsDir)) {
    for (const entry of fs.readdirSync(input.logsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const summaryPath = path.join(input.logsDir, entry.name, 'summary.json');
      if (!fs.existsSync(summaryPath)) continue;

      try {
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as { repository: string };
        const name = path.basename(summary.repository);
        if (!repos.has(name)) repos.set(name, { name, path: summary.repository, recentRuns: 0 });
        repos.get(name)!.recentRuns += 1;
      } catch {
        // A record that cannot be read is skipped: it is not a reason to lose the list.
      }
    }
  }

  return [...repos.values()].sort((a, b) => b.recentRuns - a.recentRuns);
}

/** What the factory reads from the environment about where it works, and Settings has a field for. */
const PLACE_VARIABLES = ['FACTORY_WORKSPACE_ROOT', 'FACTORY_WORKTREES_DIR'] as const;

const isGiven = (env: NodeJS.ProcessEnv, name: string): boolean => (env[name] ?? '').trim() !== '';

/** The places the environment the Studio was started with already decides: the fields in Settings do not apply to them. */
export function fixedByEnvironment(env: NodeJS.ProcessEnv): string[] {
  return PLACE_VARIABLES.filter((name) => isGiven(env, name));
}

/** Is this the workspace the factory has when nothing says otherwise - `~/workspace`? */
function isDefaultWorkspace(folder: string, home: string): boolean {
  const expanded = folder === '~' || folder.startsWith('~/') ? path.join(home, folder.slice(1)) : folder;
  return path.resolve(expanded) === path.join(home, 'workspace');
}

/**
 * The environment of a factory process: the Studio's own, plus
 *
 *  - `FACTORY_EXTRA_REPOS`: the repositories the user opened, added to whatever list the Studio was started with;
 *  - the workspace and the folder of checkouts, from Settings - but only what the user chose. The environment the
 *    Studio was started with wins (whoever set it meant it: the demo does), and so does the factory's own `.env` for a
 *    workspace Settings only shows as its default (`~/workspace` is what Settings starts with, not a decision).
 *
 * `overrides` (the provider, non-interactive mode...) win over everything.
 */
export function factoryEnvironment(input: {
  base: NodeJS.ProcessEnv;
  repositories: readonly string[];
  settings?: { workspaceRoot?: string | undefined; worktreesDir?: string | undefined };
  home?: string;
  overrides?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input.base };

  const workspace = input.settings?.workspaceRoot?.trim();
  if (workspace && !isGiven(input.base, 'FACTORY_WORKSPACE_ROOT') && !isDefaultWorkspace(workspace, input.home ?? os.homedir())) {
    env.FACTORY_WORKSPACE_ROOT = workspace;
  }
  const checkouts = input.settings?.worktreesDir?.trim();
  if (checkouts && !isGiven(input.base, 'FACTORY_WORKTREES_DIR')) env.FACTORY_WORKTREES_DIR = checkouts;

  const already = (input.base.FACTORY_EXTRA_REPOS ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  // The factory reads a list separated like PATH of absolute paths: a folder it could not be written in cannot be listed.
  const opened = input.repositories.filter((folder) => path.isAbsolute(folder) && !folder.includes(path.delimiter));
  const all = [...new Set([...already, ...opened])];
  if (all.length > 0) env.FACTORY_EXTRA_REPOS = all.join(path.delimiter);

  return { ...env, ...input.overrides };
}
