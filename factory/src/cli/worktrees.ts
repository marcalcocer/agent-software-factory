/**
 * The commands about the checkouts the factory makes for its tasks.
 *
 * Each prints ONE marker line on stdout for the Studio (`WORKTREE_LIST_JSON {...}`), like the other
 * commands it reads; a terminal user reads the same line. Kept apart from `factory.ts` so they can be tested.
 */
import { asBoolean, asString, errorMessageOf, printMarker, type FlagValue } from './flags.ts';
import { checkoutHere, removeWorktree } from '../tools/worktree.ts';
import { reportCheckouts } from '../tools/worktree-report.ts';
import { resolveRepoPath } from '../utils/factory-config.ts';

type Flags = Record<string, FlagValue>;

const usage = (message: string): number => {
  process.stderr.write(`${message}\n`);
  return 2;
};

/** Every checkout of a repository: where, which task, what is in it, and whether its pull request is over. */
export async function commandWorktreeList(flags: Flags): Promise<number> {
  const repo = asString(flags.repo);
  if (!repo) return usage('--repo is required.');
  try {
    const repoPath = resolveRepoPath(repo, { requireGit: true });
    printMarker('WORKTREE_LIST_JSON', { repoPath, worktrees: await reportCheckouts(repoPath) });
    return 0;
  } catch (error) {
    printMarker('WORKTREE_LIST_JSON', { error: errorMessageOf(error) });
    return 1;
  }
}

/** Removes one checkout. One with uncommitted changes is kept unless `--force`. The branch always stays. */
export async function commandWorktreeRemove(flags: Flags): Promise<number> {
  const repo = asString(flags.repo);
  const target = asString(flags.path);
  if (!repo || !target) return usage('--repo and --path are required.');
  try {
    const result = await removeWorktree({ mainRepoPath: resolveRepoPath(repo, { requireGit: true }), path: target, force: asBoolean(flags.force) ?? false });
    printMarker('WORKTREE_REMOVE_JSON', result);
    return result.removed ? 0 : 1;
  } catch (error) {
    printMarker('WORKTREE_REMOVE_JSON', { removed: false, reason: 'failed', message: errorMessageOf(error) });
    return 1;
  }
}

/** Removes the checkouts whose pull request is over, as long as nothing is lost. What stays is listed with the reason. */
export async function commandWorktreeGc(flags: Flags): Promise<number> {
  const repo = asString(flags.repo);
  if (!repo) return usage('--repo is required.');
  try {
    const repoPath = resolveRepoPath(repo, { requireGit: true });
    const removed: string[] = [];
    const kept: Array<{ path: string; message: string }> = [];
    for (const checkout of (await reportCheckouts(repoPath)).filter((entry) => entry.stale)) {
      const result = await removeWorktree({ mainRepoPath: repoPath, path: checkout.path });
      if (result.removed) removed.push(checkout.path);
      else kept.push({ path: checkout.path, message: result.message ?? 'It was kept.' });
    }
    printMarker('WORKTREE_GC_JSON', { removed, kept });
    return 0;
  } catch (error) {
    printMarker('WORKTREE_GC_JSON', { error: errorMessageOf(error) });
    return 1;
  }
}

/** "Check out here": the task's branch moves from its own checkout to the user's repository. */
export async function commandWorktreeCheckout(flags: Flags): Promise<number> {
  const repo = asString(flags.repo);
  const target = asString(flags.path);
  if (!repo || !target) return usage('--repo and --path are required.');
  try {
    const result = await checkoutHere({ mainRepoPath: resolveRepoPath(repo, { requireGit: true }), path: target });
    printMarker('WORKTREE_CHECKOUT_JSON', result);
    return result.ok ? 0 : 1;
  } catch (error) {
    printMarker('WORKTREE_CHECKOUT_JSON', { ok: false, error: errorMessageOf(error) });
    return 1;
  }
}
