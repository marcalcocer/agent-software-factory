/**
 * Looks at the pull requests the factory opened and reports which ones have review comments
 * nobody has dealt with yet.
 *
 * It is a plain function (and a CLI command, `pr-check`) rather than part of the Studio so that
 * the rules for "what counts as pending feedback" exist exactly once - the same
 * `fetchPullRequestReview` that the triage uses, which already ignores bots, the factory's own
 * replies and resolved threads - and so it can run headless.
 */
import fs from 'node:fs';
import path from 'node:path';

import { fetchPullRequestReview, type PullRequestComment } from './github-tools.ts';
import { assessMerge } from './pr-merge-rules.ts';
import { readArtifact } from './logger-tools.ts';
import { settlePullRequest, type SettleResult } from './pr-lifecycle.ts';
import { withStore, type PhaseStatus } from '../initiatives/store.ts';
import {
  backfillFromRuns,
  loadRegistry,
  setPullRequestState,
  type PullRequestState,
  type RegisteredPullRequest,
} from './pr-registry.ts';

export interface PendingComment extends PullRequestComment {
  /**
   * Written after the pull request was registered. Only fresh comments start work by
   * themselves; older ones are listed and wait to be asked for.
   */
  fresh: boolean;
}

export interface PullRequestCheck {
  key: string;
  repoPath: string;
  repoName: string;
  number: number;
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  rootRunId: string;
  latestRunId: string;
  round: number;
  state: PullRequestState;
  pending: PendingComment[];
  /** The commit the branch is at on GitHub. A human's approval is bound to exactly this one. */
  headSha?: string;
  /** Reasons it cannot be merged right now (conflicts, draft, ...), judged by `assessMerge`. */
  mergeBlockers?: string[];
  /** Worth knowing before merging (failing checks, ...). */
  mergeWarnings?: string[];
  /** Why this pull request could not be checked this time (the others still were). */
  error?: string;
  /**
   * Set once, by the check that found the pull request over (merged or closed on GitHub): what that did to
   * the project it belongs to, and to the task's checkout.
   */
  settled?: SettleResult;
  /** Where the task's work is: its own checkout, or the user's repository. */
  workCopy?: PullRequestWorkCopy;
  /** The project this pull request is a phase of, when it has other phases: where a comment can be deferred to. */
  roadmap?: PullRequestRoadmap;
  /** What the user decided about comments that belong to a later phase (see `scope-decide`). */
  scopeDecisions?: Array<{ commentId: string; decision: 'DEFER' | 'DO_NOW'; targetPhaseId: string | null }>;
}

export interface PullRequestWorkCopy {
  /** Runs from before checkouts existed worked in place. */
  isolation: 'worktree' | 'in-place';
  path: string;
  /** The folder is there. A checkout is removed when its pull request is over, or by the user. */
  exists: boolean;
}

export interface PullRequestRoadmap {
  initiativeId: string;
  title: string;
  /** The phase this pull request is. */
  phaseId: string;
  ordinal: number;
  /** Phases that count: the skipped ones do not. */
  total: number;
  phases: Array<{ id: string; ordinal: number; title: string; status: PhaseStatus }>;
}

export interface CheckResult {
  checkedAt: string;
  /** Open pull requests that were looked at. */
  watching: number;
  /** Pull requests discovered from earlier runs during this check. */
  backfilled: number;
  pullRequests: PullRequestCheck[];
}

export interface CheckOptions {
  /** Only this repository (absolute path). */
  repoPath?: string;
  /** Only this pull request (together with `repoPath`). */
  number?: number;
  /** How many pull requests are queried at once. */
  concurrency?: number;
  /** Injectable for tests. */
  fetchReview?: typeof fetchPullRequestReview;
}

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}

const base = (entry: RegisteredPullRequest): Omit<PullRequestCheck, 'state' | 'pending'> => ({
  key: entry.key,
  repoPath: entry.repoPath,
  repoName: entry.repoName,
  number: entry.number,
  url: entry.url,
  title: entry.title,
  headBranch: entry.headBranch,
  baseBranch: entry.baseBranch,
  rootRunId: entry.rootRunId,
  latestRunId: entry.latestRunId,
  round: entry.round,
});

export async function checkPullRequests(options: CheckOptions = {}): Promise<CheckResult> {
  const fetchReview = options.fetchReview ?? fetchPullRequestReview;
  const backfilled = await backfillFromRuns();

  const wanted = options.repoPath ? path.resolve(options.repoPath) : null;
  const entries = Object.values(loadRegistry().pullRequests).filter(
    (entry) =>
      entry.state === 'OPEN' &&
      (!wanted || path.resolve(entry.repoPath) === wanted) &&
      (options.number === undefined || entry.number === options.number),
  );

  const pullRequests = await mapLimit(entries, options.concurrency ?? 3, async (entry) => {
    try {
      const review = await fetchReview(entry.repoPath, entry.number);
      const state = (review.state || 'OPEN').toUpperCase() as PullRequestState;

      const changedDetails =
        review.title !== entry.title ||
        review.headBranch !== entry.headBranch ||
        review.baseBranch !== entry.baseBranch;
      // Only touch the registry when something is worth remembering: this runs every minute.
      if (state !== 'OPEN' || changedDetails) {
        await setPullRequestState(entry.key, state === 'OPEN' ? 'OPEN' : state, {
          title: review.title,
          headBranch: review.headBranch,
          baseBranch: review.baseBranch,
        });
      }

      if (state !== 'OPEN') {
        const settled = await settlePullRequest({ repoPath: entry.repoPath, number: entry.number, state });
        return { ...base(entry), title: review.title, state, pending: [], settled } satisfies PullRequestCheck;
      }

      const handled = new Set(entry.handledCommentIds);
      const since = Date.parse(entry.watchSince);
      const pending: PendingComment[] = review.comments
        .filter((comment) => !handled.has(comment.id))
        .map((comment) => ({ ...comment, fresh: Date.parse(comment.createdAt) >= since }));

      // Whether it can be merged is judged here, once, from what GitHub reported alongside the
      // comments: the Studio shows the verdict, it does not re-derive it.
      const merge = review.headSha
        ? assessMerge({
            state,
            isDraft: review.isDraft ?? false,
            mergeable: review.mergeable ?? 'UNKNOWN',
            mergeState: review.mergeState ?? 'UNKNOWN',
            reviewDecision: review.reviewDecision ?? '',
            checks: review.checks ?? { total: 0, failing: 0, pending: 0 },
            baseBranch: review.baseBranch,
          })
        : null;

      return {
        ...base(entry),
        title: review.title,
        headBranch: review.headBranch,
        baseBranch: review.baseBranch,
        state,
        pending,
        ...(review.headSha ? { headSha: review.headSha } : {}),
        ...(merge ? { mergeBlockers: merge.blockers, mergeWarnings: merge.warnings } : {}),
      } satisfies PullRequestCheck;
    } catch (error) {
      const message = (error as Error).message;
      // GitHub saying the pull request does not exist is a final answer (deleted, or it belongs to
      // another repository than the one this clone points at). Retrying every minute forever, with
      // an error card nobody can clear, helps no one: stop watching it.
      if (/could not resolve to a pullrequest/i.test(message)) {
        await setPullRequestState(entry.key, 'CLOSED');
        const settled = await settlePullRequest({ repoPath: entry.repoPath, number: entry.number, state: 'CLOSED' });
        return { ...base(entry), state: 'CLOSED', pending: [], settled } satisfies PullRequestCheck;
      }
      return { ...base(entry), state: entry.state, pending: [], error: message } satisfies PullRequestCheck;
    }
  });

  attachWorkCopies(pullRequests);
  await attachRoadmaps(pullRequests);

  return {
    checkedAt: new Date().toISOString(),
    watching: entries.length,
    backfilled,
    pullRequests,
  };
}

/** Tells where the work of each open pull request is, as its first run recorded it. */
function attachWorkCopies(pullRequests: PullRequestCheck[]): void {
  for (const pr of pullRequests) {
    if (pr.state !== 'OPEN') continue;
    const meta = readArtifact(pr.rootRunId, 'run.json') as { isolation?: string; workPath?: string } | null;
    const isolation = meta?.isolation === 'worktree' ? 'worktree' : 'in-place';
    const folder = isolation === 'worktree' && meta?.workPath ? meta.workPath : pr.repoPath;
    pr.workCopy = { isolation, path: folder, exists: fs.existsSync(folder) };
  }
}

/**
 * Adds to each open pull request the project it is a phase of and what the user decided about its comments,
 * so the Studio can offer "defer to phase N" without opening the database itself. A plain task (one phase)
 * has no later phase and gets nothing; a store that cannot be read costs the extra, never the check.
 */
async function attachRoadmaps(pullRequests: PullRequestCheck[]): Promise<void> {
  const open = pullRequests.filter((pr) => pr.state === 'OPEN');
  if (open.length === 0) return;
  try {
    await withStore(async (store) => {
      for (const pr of open) {
        const phase = await store.findPhaseByPullRequest(pr.repoPath, pr.number);
        const initiative = phase ? await store.getInitiative(phase.initiativeId) : null;
        if (!phase || !initiative) continue;

        const counted = initiative.phases.filter((other) => other.status !== 'SKIPPED' || other.id === phase.id);
        if (counted.length > 1) {
          pr.roadmap = {
            initiativeId: initiative.id,
            title: initiative.title,
            phaseId: phase.id,
            ordinal: phase.ordinal,
            total: counted.length,
            phases: initiative.phases.map((other) => ({ id: other.id, ordinal: other.ordinal, title: other.title, status: other.status })),
          };
        }
        const decisions = await store.listScopeDecisions(pr.key);
        if (decisions.length > 0) {
          pr.scopeDecisions = decisions.map((row) => ({ commentId: row.commentId, decision: row.decision, targetPhaseId: row.targetPhaseId }));
        }
      }
    });
  } catch {
    // The comments are what the check is for; the roadmap is a convenience.
  }
}
