/**
 * Git and GitHub tools.
 *
 * Read operations (status, diff, log, branch) are available to every agent.
 * Write operations (branch creation, commit, push, pull request) are only used by the
 * dedicated workflow steps and are gated by configuration flags, so an agent can never
 * publish anything on its own initiative.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { getFactoryConfig, resolveRepoPath } from '../utils/factory-config.ts';
import { hasExecutable, runGit, runProcess, type CommandResult } from '../utils/shell.ts';
import { loadRegistry } from './pr-registry.ts';

/** Validates a repository reference coming from an agent (keeps it inside the workspace). */
function repo(repoPath: string): string {
  return resolveRepoPath(repoPath, { requireGit: true });
}

function fail(result: CommandResult): string {
  return `git ${result.args.join(' ')} failed (exit ${result.exitCode}): ${
    result.stderr.trim() || result.stdout.trim()
  }`;
}

/* -------------------------------------------------------------------------- */
/* Plain helpers (used by workflow steps)                                      */
/* -------------------------------------------------------------------------- */

export async function getCurrentBranch(repoPath: string): Promise<string> {
  const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
  if (!result.ok) throw new Error(fail(result));
  return result.stdout.trim();
}

export async function isWorkingTreeClean(repoPath: string): Promise<boolean> {
  const result = await runGit(['status', '--porcelain'], { cwd: repoPath });
  if (!result.ok) throw new Error(fail(result));
  return result.stdout.trim() === '';
}

export interface CreateBranchOptions {
  /**
   * The branch name was chosen on purpose (e.g. to continue a pull request) rather than generated,
   * so look for it on the remote instead of assuming it is brand new: adopt it when it only
   * exists there, and fast-forward it when a reviewer has pushed on top.
   */
  adoptRemote?: boolean;
  /**
   * When the branch has to be created, cut it from the newest state of the base branch (GitHub's,
   * if it is ahead of the local one) rather than from whatever the local base happens to be.
   */
  freshStart?: boolean;
}

/**
 * Checks out `branchName`, creating it from `baseBranch` when it does not exist.
 *
 * `created` is `false` when the branch already held work (it existed locally, or was adopted
 * from the remote), which is what callers use to tell "continuing" from "starting".
 */
export async function createBranch(
  repoPath: string,
  branchName: string,
  baseBranch?: string,
  options: CreateBranchOptions = {},
): Promise<{ created: boolean; branch: string; baseBranch: string; note?: string }> {
  const base = baseBranch ?? (await getCurrentBranch(repoPath));
  const existing = await runGit(['rev-parse', '--verify', `refs/heads/${branchName}`], {
    cwd: repoPath,
  });

  if (existing.ok) {
    const checkout = await runGit(['checkout', branchName], { cwd: repoPath });
    if (!checkout.ok) throw new Error(fail(checkout));
    const note = options.adoptRemote ? await fastForwardFromRemote(repoPath, branchName) : undefined;
    return { created: false, branch: branchName, baseBranch: base, ...(note ? { note } : {}) };
  }

  if (options.adoptRemote) {
    const adopted = await adoptRemoteBranch(repoPath, branchName);
    if (adopted) return { created: false, branch: branchName, baseBranch: base };
  }

  const start = options.freshStart ? await freshestStartPoint(repoPath, base) : { ref: base };
  // `--no-track`: cut from `origin/<base>` the new branch would otherwise be set to push to the
  // base branch itself.
  const result = await runGit(['checkout', '-b', branchName, '--no-track', start.ref], { cwd: repoPath });
  if (!result.ok) throw new Error(fail(result));
  return { created: true, branch: branchName, baseBranch: base, ...(start.note ? { note: start.note } : {}) };
}

/** Best-effort `git fetch origin <branch>`; never prompts for credentials, never throws. */
export async function fetchRemoteBranch(repoPath: string, branch: string, timeoutMs?: number): Promise<boolean> {
  try {
    const remotes = await runGit(['remote'], { cwd: repoPath });
    if (!remotes.ok || remotes.stdout.trim() === '') return false;
    const fetched = await runGit(['fetch', 'origin', branch], {
      cwd: repoPath,
      env: { GIT_TERMINAL_PROMPT: '0' },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return fetched.ok;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Which branch a new task starts from                                         */
/* -------------------------------------------------------------------------- */

/** The commit a ref points at, or `null` when it does not exist. */
export async function refSha(repoPath: string, ref: string): Promise<string | null> {
  const result = await runGit(['rev-parse', '--verify', '--quiet', ref], { cwd: repoPath });
  return result.ok ? result.stdout.trim() : null;
}

/** Is `ancestor` contained in `descendant`'s history (or the same commit)? */
export async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoPath });
  return result.exitCode === 0;
}

/**
 * Subjects of a branch's latest commits (GitHub's copy first, then the local one): the style a new
 * message has to fit into. Empty when the branch cannot be read.
 */
export async function recentCommitSubjects(repoPath: string, branch: string, limit = 12): Promise<string[]> {
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const result = await runGit(['log', '-n', String(limit), '--format=%s', ref], { cwd: repoPath });
    if (result.ok && result.stdout.trim() !== '') {
      return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    }
  }
  return [];
}

/**
 * The repository's default branch: what `origin/HEAD` points at, otherwise `main` or `master`
 * (whichever exists). `null` when it cannot be told.
 */
export async function getDefaultBranch(repoPath: string): Promise<string | null> {
  const head = await runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: repoPath,
  });
  if (head.ok) {
    const name = head.stdout.trim().replace(/^origin\//, '');
    if (name) return name;
  }
  for (const candidate of ['main', 'master']) {
    if ((await refSha(repoPath, `refs/heads/${candidate}`)) || (await refSha(repoPath, `refs/remotes/origin/${candidate}`))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Is this a branch the factory made, as opposed to one the user is working on? That is the
 * `factory/` prefix it names its branches with, or the head of a pull request it opened (the user
 * can rename the branch at the delivery gate).
 */
export function isFactoryBranch(branch: string, deliveredHeads: ReadonlySet<string>): boolean {
  return branch.startsWith('factory/') || deliveredHeads.has(branch);
}

/**
 * The branch a new task should build on.
 *
 * It used to be "whatever is checked out". After a run the factory leaves its own branch checked
 * out, so the next task was cut from it and carried that run's commits into its pull request
 * (stacked, and tangled up in the first one's review). A branch the factory made earlier is
 * therefore never a base: the default branch is. A branch the user chose themselves still is -
 * working on top of one's own feature branch is a deliberate act.
 */
export async function chooseBaseBranch(repoPath: string): Promise<{ base: string; note?: string }> {
  const current = await getCurrentBranch(repoPath);

  const here = path.resolve(repoPath);
  const delivered = new Set(
    Object.values(loadRegistry().pullRequests)
      .filter((entry) => path.resolve(entry.repoPath) === here)
      .map((entry) => entry.headBranch),
  );
  if (!isFactoryBranch(current, delivered)) return { base: current };

  const fallback = await getDefaultBranch(repoPath);
  if (!fallback || fallback === current) return { base: current };
  return {
    base: fallback,
    note:
      `Started from ${fallback} instead of ${current}: ${current} is a branch the factory made earlier, ` +
      'and building on it would carry its commits into this pull request.',
  };
}

/**
 * The ref a new branch should be cut from. Brings the base branch's remote state up to date
 * (best effort - offline is fine) and picks the newer of the local and the remote branch: after a
 * pull request is merged on GitHub the local base is behind, and a task started from it would be
 * missing what was just merged. A local base that is ahead of the remote (unpushed commits of the
 * user's) wins, since that is the user's own state.
 */
export async function freshestStartPoint(
  repoPath: string,
  base: string,
): Promise<{ ref: string; note?: string }> {
  await fetchRemoteBranch(repoPath, base, 30_000);

  const local = await refSha(repoPath, `refs/heads/${base}`);
  const remote = await refSha(repoPath, `refs/remotes/origin/${base}`);
  if (!remote) return { ref: base };
  if (!local) return { ref: `origin/${base}` };
  if (local === remote) return { ref: base };

  if (await isAncestor(repoPath, local, remote)) {
    return {
      ref: `origin/${base}`,
      note: `${base} on GitHub is ahead of your local ${base}; the new branch starts from GitHub's.`,
    };
  }
  if (await isAncestor(repoPath, remote, local)) return { ref: base };
  return {
    ref: base,
    note: `Your local ${base} and ${base} on GitHub have diverged; the new branch starts from your local ${base}.`,
  };
}

/** The branch only exists on the remote (a pull request opened elsewhere): check it out tracking it. */
async function adoptRemoteBranch(repoPath: string, branch: string): Promise<boolean> {
  await fetchRemoteBranch(repoPath, branch);
  const remoteRef = `refs/remotes/origin/${branch}`;
  const known = await runGit(['rev-parse', '--verify', '--quiet', remoteRef], { cwd: repoPath });
  if (!known.ok) return false;
  const adopted = await runGit(['checkout', '-b', branch, '--track', `origin/${branch}`], {
    cwd: repoPath,
  });
  return adopted.ok;
}

/**
 * Brings a local branch up to date with the remote only when that is a pure fast-forward
 * (a reviewer committed suggestions on top). A diverged branch is left exactly as it is: merging
 * or rebasing someone's work is not a decision to take silently.
 */
export async function fastForwardFromRemote(repoPath: string, branch: string): Promise<string | undefined> {
  if (!(await fetchRemoteBranch(repoPath, branch))) return undefined;
  const remoteRef = `origin/${branch}`;
  const behind = await runGit(['rev-list', '--count', `${branch}..${remoteRef}`], { cwd: repoPath });
  if (!behind.ok || Number.parseInt(behind.stdout.trim(), 10) === 0) return undefined;

  const ahead = await runGit(['rev-list', '--count', `${remoteRef}..${branch}`], { cwd: repoPath });
  if (ahead.ok && Number.parseInt(ahead.stdout.trim(), 10) > 0) {
    return `${branch} has diverged from ${remoteRef}; left as it is.`;
  }
  const merged = await runGit(['merge', '--ff-only', remoteRef], { cwd: repoPath });
  return merged.ok
    ? `${branch} was fast-forwarded to include the commits pushed to ${remoteRef}.`
    : `${branch} could not be fast-forwarded: ${merged.stderr.trim()}`;
}

export interface DiffOptions {
  /** Compare against a ref (`<baseRef>...HEAD`) instead of the working tree. */
  baseRef?: string;
  /** Diff the staged changes only. */
  staged?: boolean;
  /** Return only the list of changed files. */
  nameOnly?: boolean;
  maxChars?: number;
  /**
   * Register untracked files with `git add --intent-to-add` before diffing (default `true`).
   *
   * Without this, newly created files are invisible to `git diff`, which would hand the
   * reviewer and the security agent an incomplete diff - the most dangerous possible
   * blind spot, since new files are where new code lives.
   */
  includeUntracked?: boolean;
}

/**
 * The most git's own output is read back, as a guard against a runaway diff (a 200 MB lockfile), not
 * as a budget. It must stay far above any real change: the shared process cap (24,000 characters,
 * the middle dropped) used to apply here, and silently reduced a 107,409-character diff to 24,040.
 */
const GIT_DIFF_READ_CAP_CHARS = 40_000_000;

/** The complete diff, however large: what the agents' view of a change is built from (see `diff-view.ts`). */
export async function getFullDiff(
  repoPath: string,
  options: Omit<DiffOptions, 'maxChars'> = {},
): Promise<{ diff: string; truncated: boolean; files: string[] }> {
  return await getDiff(repoPath, { ...options, maxChars: GIT_DIFF_READ_CAP_CHARS });
}

export async function getDiff(
  repoPath: string,
  options: DiffOptions = {},
): Promise<{ diff: string; truncated: boolean; files: string[] }> {
  const includeUntracked = options.includeUntracked ?? true;
  const comparingRefs = Boolean(options.baseRef) || options.staged === true;

  if (includeUntracked && !comparingRefs) {
    // `--intent-to-add` only records the path in the index (no content staged), so the diff
    // shows new files while the working tree stays untouched.
    await runGit(['add', '--all', '--intent-to-add'], { cwd: repoPath });
  }

  const baseArgs = ['--no-pager', 'diff'];
  if (options.staged) baseArgs.push('--cached');
  if (options.baseRef) baseArgs.push(`${options.baseRef}...HEAD`);

  // Read it all: `maxChars` below decides how much of it the caller gets, not the process capture.
  const capture = { cwd: repoPath, maxOutputChars: GIT_DIFF_READ_CAP_CHARS };
  const [diffResult, nameResult] = await Promise.all([
    runGit(options.nameOnly ? [...baseArgs, '--name-only'] : baseArgs, capture),
    runGit([...baseArgs, '--name-only'], capture),
  ]);
  if (!diffResult.ok) throw new Error(fail(diffResult));

  const maxChars = options.maxChars ?? getFactoryConfig().maxOutputChars * 2;
  const raw = diffResult.stdout;
  const truncated = raw.length > maxChars;
  const files = [
    ...new Set(
      nameResult.stdout
        .split('\n')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];

  return {
    diff: truncated
      ? `${raw.slice(0, maxChars)}\n\n[... diff truncated at ${maxChars} characters ...]`
      : raw,
    truncated,
    files,
  };
}

/* -------------------------------------------------------------------------- */
/* Snapshots of the working tree (to undo work that turns out worse)           */
/* -------------------------------------------------------------------------- */

/**
 * Records the working tree as a git tree object: what is tracked, changed, deleted and new (anything
 * `.gitignore` ignores is not part of it). Nothing is committed, and the working tree and the index
 * are left as they were.
 */
export async function snapshotWorkingTree(repoPath: string): Promise<string> {
  const add = await runGit(['add', '--all'], { cwd: repoPath });
  if (!add.ok) throw new Error(fail(add));
  try {
    const written = await runGit(['write-tree'], { cwd: repoPath });
    if (!written.ok) throw new Error(fail(written));
    return written.stdout.trim();
  } finally {
    await runGit(['reset', '--quiet'], { cwd: repoPath }); // unstage again
  }
}

/**
 * Puts the working tree back exactly as `snapshotWorkingTree` recorded it: edits are undone, files
 * deleted since are back, files created since are gone. Ignored files (dependencies, build output)
 * are not touched.
 */
export async function restoreWorkingTree(repoPath: string, tree: string): Promise<void> {
  // Stage first, so a file created since the snapshot is known to the index and read-tree removes it.
  const add = await runGit(['add', '--all'], { cwd: repoPath });
  if (!add.ok) throw new Error(fail(add));
  try {
    const read = await runGit(['read-tree', '--reset', '-u', tree], { cwd: repoPath });
    if (!read.ok) throw new Error(fail(read));
  } finally {
    await runGit(['reset', '--quiet'], { cwd: repoPath });
  }
}

export interface ChangesSince {
  files: string[];
  additions: number;
  deletions: number;
  /** The patch between the snapshot and now. */
  patch: string;
}

/** What changed in the working tree since a snapshot. */
export async function changesSince(repoPath: string, tree: string): Promise<ChangesSince> {
  const add = await runGit(['add', '--all'], { cwd: repoPath });
  if (!add.ok) throw new Error(fail(add));
  try {
    const capture = { cwd: repoPath, maxOutputChars: GIT_DIFF_READ_CAP_CHARS };
    const [stat, patch] = await Promise.all([
      runGit(['--no-pager', 'diff', '--cached', '--numstat', tree], capture),
      runGit(['--no-pager', 'diff', '--cached', tree], capture),
    ]);
    if (!stat.ok) throw new Error(fail(stat));
    if (!patch.ok) throw new Error(fail(patch));

    const files: string[] = [];
    let additions = 0;
    let deletions = 0;
    for (const line of stat.stdout.split('\n')) {
      const [added, removed, ...path] = line.split('\t');
      if (path.length === 0) continue;
      files.push(path.join('\t'));
      additions += Number.parseInt(added ?? '', 10) || 0; // a binary file reports "-"
      deletions += Number.parseInt(removed ?? '', 10) || 0;
    }
    return { files, additions, deletions, patch: patch.stdout };
  } finally {
    await runGit(['reset', '--quiet'], { cwd: repoPath });
  }
}

export async function commitAll(
  repoPath: string,
  message: string,
): Promise<{ committed: boolean; sha: string | null; reason?: string }> {
  if (await isWorkingTreeClean(repoPath)) {
    return { committed: false, sha: null, reason: 'Working tree is clean: nothing to commit.' };
  }
  const add = await runGit(['add', '-A'], { cwd: repoPath });
  if (!add.ok) throw new Error(fail(add));

  const commit = await runGit(['commit', '-m', message], { cwd: repoPath });
  if (!commit.ok) throw new Error(fail(commit));

  const sha = await runGit(['rev-parse', 'HEAD'], { cwd: repoPath });
  return { committed: true, sha: sha.ok ? sha.stdout.trim() : null };
}

/**
 * Where a work branch stands relative to its remote and to the base branch.
 *
 * The delivery step needs the full picture rather than a single boolean: `commitAll` reports
 * `committed: false` when the tree is already clean, so a resumed or retried run may have a
 * branch that is already pushed (nothing to push) yet still has no pull request.
 */
export interface BranchPublication {
  /** The repository has at least one git remote. */
  hasRemote: boolean;
  /** The branch exists locally. */
  localExists: boolean;
  /** The branch (or its configured upstream) is known on the remote. */
  remoteExists: boolean;
  /** Local commits the remote does not have yet (the whole branch when the remote lacks it). */
  unpushed: number;
  /** Commits on the branch that the base branch does not have, i.e. the work to deliver. */
  aheadOfBase: number;
  /** True when a push is needed to publish the branch. */
  needsPush: boolean;
  /** True when the branch is on the remote and the remote holds everything. */
  published: boolean;
}

async function countCommits(repoPath: string, range: string): Promise<number> {
  const result = await runGit(['rev-list', '--count', range], { cwd: repoPath });
  if (!result.ok) return 0;
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

export async function inspectBranchPublication(
  repoPath: string,
  branch: string,
  baseBranch?: string,
): Promise<BranchPublication> {
  const empty: BranchPublication = {
    hasRemote: false,
    localExists: false,
    remoteExists: false,
    unpushed: 0,
    aheadOfBase: 0,
    needsPush: false,
    published: false,
  };

  try {
    const remotes = await runGit(['remote'], { cwd: repoPath });
    const hasRemote = remotes.ok && remotes.stdout.trim() !== '';

    const localRef = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repoPath,
    });
    const localExists = localRef.ok;
    if (!localExists) return { ...empty, hasRemote };

    // Work to deliver = commits the base branch lacks. Fall back to origin/<base> when the
    // base only exists as a remote-tracking ref.
    let aheadOfBase = 0;
    if (baseBranch) {
      const baseLocal = await runGit(['rev-parse', '--verify', '--quiet', baseBranch], {
        cwd: repoPath,
      });
      const baseRef = baseLocal.ok ? baseBranch : `origin/${baseBranch}`;
      aheadOfBase = await countCommits(repoPath, `${baseRef}..${branch}`);
    }

    if (!hasRemote) {
      return { ...empty, hasRemote, localExists, aheadOfBase };
    }

    // Prefer the configured upstream; fall back to origin/<branch>.
    const upstream = await runGit(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], {
      cwd: repoPath,
    });
    const remoteRef = upstream.ok ? upstream.stdout.trim() : `origin/${branch}`;
    const remoteLookup = await runGit(['rev-parse', '--verify', '--quiet', remoteRef], {
      cwd: repoPath,
    });
    const remoteExists = remoteLookup.ok;

    // Compare the branch itself (not HEAD) so the answer is independent of the checkout.
    const unpushed = remoteExists
      ? await countCommits(repoPath, `${remoteRef}..${branch}`)
      : Math.max(aheadOfBase, 1);

    return {
      hasRemote,
      localExists,
      remoteExists,
      unpushed,
      aheadOfBase,
      needsPush: !remoteExists || unpushed > 0,
      published: remoteExists && unpushed === 0,
    };
  } catch {
    return empty;
  }
}

/** Commit a branch currently points at, or `null` when the branch does not exist. */
export async function getBranchSha(repoPath: string, branch: string): Promise<string | null> {
  const result = await runGit(['rev-parse', '--verify', '--quiet', branch], { cwd: repoPath });
  return result.ok ? result.stdout.trim() : null;
}

/** Full message of the commit `ref` points at, or `null` when it cannot be read. */
export async function getCommitMessage(repoPath: string, ref: string): Promise<string | null> {
  const result = await runGit(['log', '-1', '--format=%B', ref], { cwd: repoPath });
  return result.ok ? result.stdout.trim() : null;
}

/**
 * Rewrites the message of the tip commit of the checked-out branch.
 *
 * This rewrites history, so the caller must only use it on a commit that has not been pushed;
 * the delivery step checks that before offering the edit at all.
 */
export async function amendTipCommitMessage(
  repoPath: string,
  message: string,
): Promise<{ amended: boolean; sha: string | null; reason?: string }> {
  try {
    const amend = await runGit(['commit', '--amend', '-m', message], { cwd: repoPath });
    if (!amend.ok) return { amended: false, sha: null, reason: fail(amend) };
    const sha = await runGit(['rev-parse', 'HEAD'], { cwd: repoPath });
    return { amended: true, sha: sha.ok ? sha.stdout.trim() : null };
  } catch (error) {
    return { amended: false, sha: null, reason: (error as Error).message };
  }
}

/**
 * Renames a local branch. Refuses invalid names (git's own rules, not a lookalike regex) and
 * names that are already taken, so a typo can never clobber another branch.
 */
export async function renameBranch(
  repoPath: string,
  from: string,
  to: string,
): Promise<{ renamed: boolean; reason?: string }> {
  try {
    const valid = await runGit(['check-ref-format', '--branch', to], { cwd: repoPath });
    if (!valid.ok) return { renamed: false, reason: `"${to}" is not a valid branch name.` };

    const taken = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${to}`], {
      cwd: repoPath,
    });
    if (taken.ok) return { renamed: false, reason: `a branch named "${to}" already exists.` };

    const rename = await runGit(['branch', '-m', from, to], { cwd: repoPath });
    return rename.ok ? { renamed: true } : { renamed: false, reason: fail(rename) };
  } catch (error) {
    return { renamed: false, reason: (error as Error).message };
  }
}

/**
 * Does `branch` hold commits that are not on its remote counterpart yet?
 * Thin wrapper over {@link inspectBranchPublication}, kept for callers that only need the flag.
 */
export async function hasUnpushedCommits(repoPath: string, branch: string): Promise<boolean> {
  return (await inspectBranchPublication(repoPath, branch)).needsPush;
}

export async function pushBranch(
  repoPath: string,
  branch: string,
): Promise<{ pushed: boolean; reason?: string }> {
  if (!getFactoryConfig().allowPush) {
    return { pushed: false, reason: 'Push disabled (FACTORY_ALLOW_PUSH=false).' };
  }

  try {
    const remotes = await runGit(['remote'], { cwd: repoPath });
    if (!remotes.ok || remotes.stdout.trim() === '') {
      return { pushed: false, reason: 'Repository has no git remote configured.' };
    }
    // GIT_TERMINAL_PROMPT=0: a missing credential must fail fast, not hang waiting on a TTY.
    const result = await runGit(['push', '-u', 'origin', branch], {
      cwd: repoPath,
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
    return result.ok ? { pushed: true } : { pushed: false, reason: fail(result) };
  } catch (error) {
    return { pushed: false, reason: `Push failed unexpectedly: ${(error as Error).message}` };
  }
}

export interface PullRequestOptions {
  title: string;
  body: string;
  baseBranch: string;
  /**
   * Open as a draft. Off by default: the factory's pull requests are opened ready for review,
   * because the human already approved the delivery before it got here.
   */
  draft?: boolean;
  /**
   * Branch that holds the work. Passed as `--head` so the pull request does not depend on
   * which branch happens to be checked out in the repository.
   */
  headBranch?: string;
  labels?: string[];
}

export interface PullRequestResult {
  created: boolean;
  url: string | null;
  reason?: string;
  /** A pull request for this branch was already open; its URL is returned instead of failing. */
  alreadyExisted?: boolean;
  /** Labels dropped because the repository does not define them (the PR is still opened). */
  droppedLabels?: string[];
}

/** First http(s) URL in `gh` output, if any. */
function firstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0].replace(/[).,;]+$/, '') : null;
}

/** Heuristic: did `gh` fail because the user is not logged in / lacks permission? */
function looksLikeAuthFailure(output: string): boolean {
  return /gh auth login|not logged in|authentication|requires authentication|bad credentials|GH_TOKEN|HTTP 401|HTTP 403|Resource not accessible/i.test(
    output,
  );
}

/**
 * Opens a pull request (ready for review unless `draft` is set) with the GitHub CLI.
 *
 * This function never throws: it runs after the branch has been pushed, so an exception here
 * would abort the delivery step *after* the irreversible part and lose the record of what was
 * published. Every failure is returned as `{ created: false, reason }` instead.
 */
export async function createPullRequest(
  repoPath: string,
  options: PullRequestOptions,
): Promise<PullRequestResult> {
  if (!getFactoryConfig().allowPullRequest) {
    return { created: false, url: null, reason: 'PR creation disabled (FACTORY_ALLOW_PR=false).' };
  }

  let bodyDir: string | null = null;
  try {
    if (!(await hasExecutable('gh', repoPath))) {
      return {
        created: false,
        url: null,
        reason: 'GitHub CLI (`gh`) not found. Install it and run `gh auth login` to open PRs.',
      };
    }

    // The PR body goes through a temporary file to avoid any shell / argument-size issue.
    // os.tmpdir() rather than `.git/`: `.git` is a file (not a directory) in worktrees and
    // submodules, which made the previous location fail.
    bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-pr-'));
    const bodyFile = path.join(bodyDir, 'body.md');
    fs.writeFileSync(bodyFile, options.body, 'utf8');

    const baseArgs = [
      'pr',
      'create',
      ...(options.draft ? ['--draft'] : []),
      '--base',
      options.baseBranch,
      ...(options.headBranch ? ['--head', options.headBranch] : []),
      '--title',
      options.title,
      '--body-file',
      bodyFile,
    ];
    // `gh` is invoked as trusted (it is not on the agent command allow-list): this is the
    // factory itself acting, never an agent. Prompts are disabled so it cannot hang on a TTY.
    const ghOptions = {
      cwd: repoPath,
      trusted: true,
      env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
    };

    const labels = options.labels ?? [];
    const withLabels = [...baseArgs, ...labels.flatMap((label) => ['--label', label])];
    let result = await runProcess('gh', withLabels, ghOptions);
    let droppedLabels: string[] | undefined;

    // `gh` resolves labels *before* creating the PR, so a label the repository does not define
    // aborts the whole command. The PR matters more than its labels: retry without them.
    if (!result.ok && labels.length > 0 && /label/i.test(`${result.stderr}\n${result.stdout}`)) {
      const retry = await runProcess('gh', baseArgs, ghOptions);
      if (retry.ok) {
        result = retry;
        droppedLabels = labels;
      }
    }

    const output = `${result.stdout}\n${result.stderr}`;

    if (result.ok) {
      return {
        created: true,
        url: firstUrl(result.stdout) ?? firstUrl(result.stderr),
        ...(droppedLabels ? { droppedLabels } : {}),
      };
    }

    // Retrying delivery after a partial failure: the PR may already be open. That is a
    // successful outcome for the user, so surface its URL instead of an error.
    if (/already exists/i.test(output)) {
      const existing = firstUrl(output);
      if (existing) return { created: true, url: existing, alreadyExisted: true };
    }

    if (looksLikeAuthFailure(output)) {
      return {
        created: false,
        url: null,
        reason:
          'GitHub CLI (`gh`) is not authenticated for this repository. Run `gh auth login` ' +
          `once, then retry the delivery step. (${output.trim().split('\n')[0] ?? 'no details'})`,
      };
    }

    return {
      created: false,
      url: null,
      reason: `gh pr create failed (exit ${result.exitCode}): ${
        result.stderr.trim() || result.stdout.trim() || 'no output'
      }`,
    };
  } catch (error) {
    return {
      created: false,
      url: null,
      reason: `Opening the pull request failed unexpectedly: ${(error as Error).message}`,
    };
  } finally {
    if (bodyDir) fs.rmSync(bodyDir, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* Agent-facing tools                                                         */
/* -------------------------------------------------------------------------- */

export const gitStatusTool = createTool({
  id: 'git-status',
  description:
    'Show the git status of the target repository: current branch, staged/unstaged/untracked ' +
    'files and whether the working tree is clean.',
  inputSchema: z.object({
    repoPath: z.string().describe('Absolute path of the target repository.'),
  }),
  outputSchema: z.object({
    branch: z.string(),
    clean: z.boolean(),
    porcelain: z.string(),
    changedFiles: z.array(z.string()),
  }),
  execute: async ({ repoPath }) => {
    const cwd = repo(repoPath);
    const [branch, status] = await Promise.all([
      getCurrentBranch(cwd),
      runGit(['status', '--porcelain'], { cwd }),
    ]);
    if (!status.ok) throw new Error(fail(status));
    const porcelain = status.stdout;
    return {
      branch,
      clean: porcelain.trim() === '',
      porcelain,
      changedFiles: porcelain
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter(Boolean),
    };
  },
});

export const gitDiffTool = createTool({
  id: 'git-diff',
  description:
    'Show the current changes of the target repository as a unified diff. Use `nameOnly` for a ' +
    'cheap overview first, then request the full diff. Use `baseRef` to compare against a branch.',
  inputSchema: z.object({
    repoPath: z.string(),
    baseRef: z.string().optional().describe('Compare against this ref (e.g. "main").'),
    staged: z.boolean().optional().describe('Diff the staged changes only.'),
    nameOnly: z.boolean().optional().describe('Return only the list of changed files.'),
    maxChars: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    diff: z.string(),
    files: z.array(z.string()),
    truncated: z.boolean(),
  }),
  execute: async ({ repoPath, baseRef, staged, nameOnly, maxChars }) => {
    const options: DiffOptions = {};
    if (baseRef !== undefined) options.baseRef = baseRef;
    if (staged !== undefined) options.staged = staged;
    if (nameOnly !== undefined) options.nameOnly = nameOnly;
    if (maxChars !== undefined) options.maxChars = maxChars;
    return await getDiff(repo(repoPath), options);
  },
});

export const gitLogTool = createTool({
  id: 'git-log',
  description:
    'Show recent commits of the target repository to understand its history and commit-message ' +
    'conventions.',
  inputSchema: z.object({
    repoPath: z.string(),
    limit: z.number().int().min(1).max(100).default(15),
    filePath: z.string().optional().describe('Restrict the history to one file or folder.'),
  }),
  outputSchema: z.object({ commits: z.array(z.string()) }),
  execute: async ({ repoPath, limit, filePath }) => {
    const args = ['--no-pager', 'log', `-n${limit}`, '--pretty=format:%h %ad %an: %s', '--date=short'];
    if (filePath) args.push('--', filePath);
    const result = await runGit(args, { cwd: repo(repoPath) });
    if (!result.ok) throw new Error(fail(result));
    return { commits: result.stdout.split('\n').filter(Boolean) };
  },
});

export const gitCreateBranchTool = createTool({
  id: 'git-create-branch',
  description:
    'Create (or check out, if it already exists) a work branch in the target repository. ' +
    'Reserved for the factory preparation step.',
  inputSchema: z.object({
    repoPath: z.string(),
    branchName: z.string(),
    baseBranch: z.string().optional(),
  }),
  outputSchema: z.object({
    created: z.boolean(),
    branch: z.string(),
    baseBranch: z.string(),
  }),
  execute: async ({ repoPath, branchName, baseBranch }) =>
    await createBranch(repo(repoPath), branchName, baseBranch),
});

export const gitCommitTool = createTool({
  id: 'git-commit',
  description:
    'Stage every change and create a commit in the target repository. Reserved for the factory ' +
    'delivery step: implementation agents must never commit.',
  inputSchema: z.object({
    repoPath: z.string(),
    message: z.string().describe('Conventional Commits message.'),
  }),
  outputSchema: z.object({
    committed: z.boolean(),
    sha: z.string().nullable(),
    reason: z.string().optional(),
  }),
  execute: async ({ repoPath, message }) => await commitAll(repo(repoPath), message),
});

export const gitPushTool = createTool({
  id: 'git-push',
  description:
    'Push the work branch to `origin` (requires FACTORY_ALLOW_PUSH=true). Reserved for the ' +
    'factory delivery step.',
  inputSchema: z.object({ repoPath: z.string(), branch: z.string() }),
  outputSchema: z.object({ pushed: z.boolean(), reason: z.string().optional() }),
  execute: async ({ repoPath, branch }) => await pushBranch(repo(repoPath), branch),
});

export const gitCreatePullRequestTool = createTool({
  id: 'git-create-pull-request',
  description:
    'Open a pull request with the GitHub CLI, ready for review unless `draft` is true (requires ' +
    'FACTORY_ALLOW_PR=true and an authenticated `gh`). Reserved for the factory delivery step.',
  inputSchema: z.object({
    repoPath: z.string(),
    title: z.string(),
    body: z.string(),
    baseBranch: z.string(),
    labels: z.array(z.string()).optional(),
    draft: z.boolean().optional(),
  }),
  outputSchema: z.object({
    created: z.boolean(),
    url: z.string().nullable(),
    reason: z.string().optional(),
  }),
  execute: async ({ repoPath, title, body, baseBranch, labels, draft }) =>
    await createPullRequest(repo(repoPath), {
      title,
      body,
      baseBranch,
      ...(labels === undefined ? {} : { labels }),
      ...(draft === undefined ? {} : { draft }),
    }),
});

/** Read-only git tools, safe for every agent. */
export const gitReadTools = {
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
};

/** Write tools, used by the delivery step only. */
export const gitWriteTools = {
  gitCreateBranchTool,
  gitCommitTool,
  gitPushTool,
  gitCreatePullRequestTool,
};

/** What the human may still change about the delivery, and why anything is locked. */
export interface DeliveryEditability {
  /** The commit message can be rewritten (a single, unpushed commit on the checked-out branch). */
  commitEditable: boolean;
  commitLockedReason?: string;
  /** The branch can be renamed (it is not on the remote yet). */
  branchEditable: boolean;
  branchLockedReason?: string;
}

/**
 * Decides which parts of a delivery can still be edited without rewriting published history.
 *
 * Editing the title or description of a pull request is always safe. A commit message is part of
 * the commit's identity: changing it after the commit was pushed would need a force-push, and
 * renaming a pushed branch would leave the old one behind on the remote. Those stay locked.
 */
export async function assessDeliveryEditability(
  repoPath: string,
  branch: string,
  publication: BranchPublication | null,
): Promise<DeliveryEditability> {
  if (!publication?.localExists) {
    const reason = 'The branch does not exist locally.';
    return { commitEditable: false, commitLockedReason: reason, branchEditable: false, branchLockedReason: reason };
  }

  const result: DeliveryEditability = { commitEditable: true, branchEditable: true };

  if (publication.remoteExists) {
    result.branchEditable = false;
    result.branchLockedReason =
      'The branch is already on the remote; renaming it would leave the old branch behind there.';
  }

  const unpublished = !publication.remoteExists || publication.unpushed > 0;
  if (!unpublished) {
    result.commitEditable = false;
    result.commitLockedReason =
      'The commit is already on the remote, so changing its message would mean force-pushing.';
  } else if (publication.unpushed !== 1) {
    // Amending rewrites only the tip commit, which is safe exactly when it is the one and only
    // commit that has not been published. (Counting *unpublished* commits, not all commits on
    // the branch, is what lets a follow-up commit on top of an already-pushed PR branch be
    // edited, while still refusing to guess which of several unpublished commits is meant.)
    result.commitEditable = false;
    result.commitLockedReason = `The branch has ${publication.unpushed} unpublished commits; only a single commit can be edited.`;
  } else {
    let current: string | null = null;
    try {
      current = await getCurrentBranch(repoPath);
    } catch {
      current = null;
    }
    if (current !== branch) {
      result.commitEditable = false;
      result.commitLockedReason = 'The branch is not checked out, so its commit cannot be amended safely.';
    }
  }

  return result;
}
