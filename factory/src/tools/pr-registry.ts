/**
 * The pull requests the factory opened, and which of their review comments are already dealt with.
 *
 * This is what lets the factory keep watching a pull request after the run that created it has
 * ended: the delivery step registers the PR here the moment it exists (that is the "notification"
 * to the feedback watcher), and the watcher reads it back every minute.
 *
 * One JSON file in the log directory. The factory is the only writer of this file; the Studio keeps
 * its own, separate state next to it, so two processes never write the same file. Writers from
 * several factory processes (two runs delivering at once) are serialised with a lock directory and
 * every write is an atomic rename, so a reader never sees a half-written file.
 */
import fs from 'node:fs';
import path from 'node:path';

import { getFactoryConfig } from '../utils/factory-config.ts';

export type PullRequestState = 'OPEN' | 'MERGED' | 'CLOSED';

export interface RegisteredPullRequest {
  /** `<repoPath>#<number>` - stable across restarts and rounds. */
  key: string;
  repoPath: string;
  repoName: string;
  number: number;
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  /** The run that opened the pull request (round 1). */
  rootRunId: string;
  /** The most recent run that touched it - the one a new round continues from. */
  latestRunId: string;
  round: number;
  /**
   * Comments created before this instant are "old": still listed, but never acted on
   * automatically. Without it, registering a pull request that already has comments (or
   * discovering one from an old run) would silently spend tokens on stale feedback.
   */
  watchSince: string;
  state: PullRequestState;
  /** Set when the factory merged it on the user's say-so (`pr-merge`). */
  mergedAt?: string;
  /** The commit the squash merge created on the base branch. */
  mergeCommit?: string;
  /** Comments already addressed (or deliberately set aside). */
  handledCommentIds: string[];
  registeredAt: string;
  updatedAt: string;
}

interface RegistryFile {
  version: 1;
  pullRequests: Record<string, RegisteredPullRequest>;
}

export const pullRequestKey = (repoPath: string, number: number): string => `${repoPath}#${number}`;

/** `https://github.com/o/r/pull/42` -> 42 */
export function pullRequestNumberFromUrl(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

const registryFile = (): string => path.join(getFactoryConfig().logDir, 'pr-registry.json');

function emptyRegistry(): RegistryFile {
  return { version: 1, pullRequests: {} };
}

/** Reads the registry. A missing or unreadable file is an empty registry, never an error. */
export function loadRegistry(): RegistryFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile(), 'utf8')) as Partial<RegistryFile>;
    if (parsed && typeof parsed === 'object' && parsed.pullRequests) {
      return { version: 1, pullRequests: parsed.pullRequests };
    }
  } catch {
    // Missing, or torn by something other than us: start clean rather than refuse to run.
  }
  return emptyRegistry();
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 3_000;

/** Runs `fn` while holding the registry lock. `mkdir` is atomic, which is all a lock needs. */
async function withLock<T>(fn: () => T): Promise<T> {
  const lock = `${registryFile()}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const startedWaiting = Date.now();

  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        // A crashed writer must not block everyone forever.
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true });
      } catch {
        // Someone else released it in the meantime.
      }
      if (Date.now() - startedWaiting > LOCK_WAIT_MS) {
        // Proceeding unlocked beats failing a delivery over bookkeeping.
        return fn();
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function saveRegistry(registry: RegistryFile): void {
  const file = registryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

/**
 * Load, change, save - under the lock. `change` may return `false` to say "nothing to write",
 * which keeps a no-op (e.g. an unknown pull request) from creating or rewriting the file.
 */
export async function mutateRegistry(change: (registry: RegistryFile) => boolean | void): Promise<void> {
  await withLock(() => {
    const registry = loadRegistry();
    if (change(registry) === false) return;
    saveRegistry(registry);
  });
}

export interface PullRequestRegistration {
  repoPath: string;
  number: number;
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  runId: string;
  /** Defaults to `runId` (the run that opened the pull request). */
  rootRunId?: string;
  round?: number;
  /** Where the comment baseline starts. Defaults to now. */
  watchSince?: string;
}

/**
 * Starts (or keeps) watching a pull request. Safe to call again for the same one - a later round
 * moves `latestRunId` forward but never resets what was already handled or the comment baseline.
 */
export async function registerPullRequest(input: PullRequestRegistration): Promise<RegisteredPullRequest> {
  const key = pullRequestKey(input.repoPath, input.number);
  const now = new Date().toISOString();
  let result!: RegisteredPullRequest;

  await mutateRegistry((registry) => {
    const existing = registry.pullRequests[key];
    result = {
      key,
      repoPath: input.repoPath,
      repoName: path.basename(input.repoPath),
      number: input.number,
      url: input.url,
      title: input.title || existing?.title || `Pull request #${input.number}`,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      rootRunId: existing?.rootRunId ?? input.rootRunId ?? input.runId,
      latestRunId: input.runId,
      round: Math.max(existing?.round ?? 1, input.round ?? 1),
      watchSince: existing?.watchSince ?? input.watchSince ?? now,
      state: 'OPEN',
      handledCommentIds: existing?.handledCommentIds ?? [],
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    };
    registry.pullRequests[key] = result;
  });

  return result;
}

/** Records that these comments are done with, so they stop counting as pending. */
export async function markCommentsHandled(key: string, commentIds: string[]): Promise<void> {
  if (commentIds.length === 0) return;
  await mutateRegistry((registry) => {
    const entry = registry.pullRequests[key];
    if (!entry) return false;
    entry.handledCommentIds = [...new Set([...entry.handledCommentIds, ...commentIds])];
    entry.updatedAt = new Date().toISOString();
  });
}

/** Remembers whether a pull request is still open, so merged / closed ones are not polled forever. */
export async function setPullRequestState(
  key: string,
  state: PullRequestState,
  details: Partial<
    Pick<RegisteredPullRequest, 'title' | 'headBranch' | 'baseBranch' | 'mergedAt' | 'mergeCommit'>
  > = {},
): Promise<void> {
  await mutateRegistry((registry) => {
    const entry = registry.pullRequests[key];
    if (!entry) return false;
    entry.state = state;
    if (details.title) entry.title = details.title;
    if (details.headBranch) entry.headBranch = details.headBranch;
    if (details.baseBranch) entry.baseBranch = details.baseBranch;
    if (details.mergedAt) entry.mergedAt = details.mergedAt;
    if (details.mergeCommit) entry.mergeCommit = details.mergeCommit;
    entry.updatedAt = new Date().toISOString();
  });
}

/**
 * Finds pull requests created by earlier runs that were never registered (the run predates the
 * registry) by reading their delivery reports. They get a comment baseline of "now", so whatever
 * feedback they already have is shown but not acted on without being asked.
 *
 * @returns how many were added.
 */
export async function backfillFromRuns(): Promise<number> {
  const logDir = getFactoryConfig().logDir;
  if (!fs.existsSync(logDir)) return 0;

  const discovered: PullRequestRegistration[] = [];
  const known = loadRegistry().pullRequests;

  for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const dir = path.join(logDir, entry.name);
      const artifactFile = path.join(dir, '08-pull-request.json');
      if (!fs.existsSync(artifactFile)) continue;

      const artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8')) as {
        data?: {
          delivery?: { pullRequestUrl?: string | null; branch?: string };
          pullRequest?: { title?: string };
          baseBranch?: string;
        };
      };
      const url = artifact.data?.delivery?.pullRequestUrl;
      const number = url ? pullRequestNumberFromUrl(url) : null;
      if (!url || !number) continue;

      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as {
        repoPath?: string;
        branch?: string;
        baseBranch?: string;
        rootRunId?: string;
        round?: number;
      };
      if (!meta.repoPath) continue;
      if (known[pullRequestKey(meta.repoPath, number)]) continue;

      discovered.push({
        repoPath: meta.repoPath,
        number,
        url,
        title: artifact.data?.pullRequest?.title ?? '',
        headBranch: artifact.data?.delivery?.branch ?? meta.branch ?? '',
        baseBranch: artifact.data?.baseBranch ?? meta.baseBranch ?? 'main',
        runId: entry.name,
        rootRunId: meta.rootRunId ?? entry.name,
        round: meta.round ?? 1,
      });
    } catch {
      // A run directory that is not readable is simply not a source of pull requests.
    }
  }

  // Oldest first, so a later round of the same pull request wins as `latestRunId`.
  discovered.sort((a, b) => a.runId.localeCompare(b.runId));
  for (const registration of discovered) await registerPullRequest(registration);
  return discovered.length;
}
