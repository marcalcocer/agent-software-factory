/**
 * GitHub pull-request review operations.
 *
 * Powers the PR feedback loop: read the human review (top-level comments, review bodies and
 * inline thread comments), then post replies once the factory has acted on them.
 *
 * Everything goes through the `gh` CLI, which the user has already authenticated, so no extra
 * token handling is needed. Reads are safe; every write is explicit and recorded.
 */
import { runProcess } from '../utils/shell.ts';
import { summarizeChecks, type CheckSummary } from './pr-merge-rules.ts';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** Where a comment came from: a PR conversation, a review summary or an inline code thread. */
export type CommentSource = 'ISSUE_COMMENT' | 'REVIEW_BODY' | 'REVIEW_THREAD';

export interface PullRequestComment {
  /** GitHub node/database id, used to reply to the right thread. */
  id: string;
  source: CommentSource;
  author: string;
  body: string;
  createdAt: string;
  /**
   * Inline comments only: the review *thread* the comment belongs to. Replying and resolving
   * work on the thread, not on a single comment - using the comment id there silently failed, so
   * answers to inline comments were never posted.
   */
  threadId?: string;
  /** Inline comments only: the file the reviewer commented on. */
  path?: string;
  /** Inline comments only: the line in the diff. */
  line?: number;
  /** Review summaries only: APPROVED / CHANGES_REQUESTED / COMMENTED. */
  reviewState?: string;
  /** True when the inline thread has already been resolved on GitHub. */
  resolved?: boolean;
}

export interface PullRequestReview {
  number: number;
  title: string;
  state: string;
  headBranch: string;
  baseBranch: string;
  url: string;
  comments: PullRequestComment[];
  /**
   * What decides whether it can be merged. Optional so a reader that only cares about the
   * comments (and a test double) need not supply them.
   */
  headSha?: string;
  isDraft?: boolean;
  isCrossRepository?: boolean;
  /** MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable?: string;
  /** CLEAN | UNSTABLE | HAS_HOOKS | BLOCKED | BEHIND | DIRTY | DRAFT | UNKNOWN */
  mergeState?: string;
  reviewDecision?: string;
  checks?: CheckSummary;
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

async function hasGh(cwd: string): Promise<boolean> {
  const result = await runProcess('gh', ['--version'], { cwd, trusted: true, timeoutMs: 15_000 });
  return result.ok;
}

/** Runs a `gh` command and parses its stdout as JSON. */
export async function ghJson<T>(cwd: string, args: string[]): Promise<T> {
  const result = await runProcess('gh', args, { cwd, trusted: true, timeoutMs: 60_000 });
  if (!result.ok) {
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed (exit ${result.exitCode}): ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} returned non-JSON output.`);
  }
}

/** Bot authors whose comments must never be treated as human review feedback. */
const BOT_AUTHORS = new Set(['github-actions', 'github-actions[bot]', 'dependabot[bot]']);

/** Hidden marker on every factory reply, so its own comments are never re-triaged. */
export const FACTORY_REPLY_MARKER = '<!-- agent-software-factory -->';

/**
 * Visible label on everything the factory posts.
 *
 * The factory writes through the user's own GitHub account (`gh` is signed in as them), so without
 * this a reply is indistinguishable from something the user typed. A hidden marker is not enough:
 * the people reading the pull request have to be able to *see* that an AI wrote it.
 */
export const AI_LABEL = '> 🤖 **AI software factory** · automated reply, posted through this account';

/** Marks `body` as written by the factory: visible label on top, hidden marker at the bottom. */
export function signAsAi(body: string): string {
  const text = body.trim();
  // Never sign twice (a retry, or a caller that already did).
  if (text.includes(FACTORY_REPLY_MARKER)) return text;
  return `${AI_LABEL}\n\n${text}\n\n${FACTORY_REPLY_MARKER}`;
}

function isFactoryOwnComment(body: string): boolean {
  return body.includes(FACTORY_REPLY_MARKER);
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Fetches a pull request with every piece of review feedback attached.
 *
 * GitHub splits review feedback across three places, and all three matter:
 *   - `comments`      the PR conversation tab
 *   - `reviews`       the summary a reviewer writes when approving / requesting changes
 *   - `reviewThreads` inline comments anchored to a file and line
 *
 * Replies written by the factory itself and comments from bots are filtered out, so a feedback
 * run never reacts to its own output.
 */
export async function fetchPullRequestReview(
  repoPath: string,
  prNumber: number,
  options: { includeResolved?: boolean } = {},
): Promise<PullRequestReview> {
  if (!(await hasGh(repoPath))) {
    throw new Error('GitHub CLI (`gh`) not found. Install it and run `gh auth login`.');
  }

  const pr = await ghJson<{
    number: number;
    title: string;
    state: string;
    url: string;
    headRefName: string;
    baseRefName: string;
    headRefOid?: string;
    isDraft?: boolean;
    isCrossRepository?: boolean;
    mergeable?: string;
    mergeStateStatus?: string;
    reviewDecision?: string;
    statusCheckRollup?: unknown;
    comments: Array<{ id: string; author: { login: string } | null; body: string; createdAt: string }>;
    reviews: Array<{
      id: string;
      author: { login: string } | null;
      body: string;
      state: string;
      submittedAt: string;
    }>;
  }>(repoPath, [
    'pr',
    'view',
    String(prNumber),
    '--json',
    'number,title,state,url,headRefName,baseRefName,headRefOid,isDraft,isCrossRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,comments,reviews',
  ]);

  const comments: PullRequestComment[] = [];

  for (const comment of pr.comments ?? []) {
    const author = comment.author?.login ?? 'unknown';
    if (BOT_AUTHORS.has(author) || isFactoryOwnComment(comment.body)) continue;
    comments.push({
      id: String(comment.id),
      source: 'ISSUE_COMMENT',
      author,
      body: comment.body,
      createdAt: comment.createdAt,
    });
  }

  for (const review of pr.reviews ?? []) {
    const author = review.author?.login ?? 'unknown';
    // A PENDING review is a draft: its author is still writing it and nobody else can see it.
    // Acting on it would answer a review that has not been given yet.
    if (review.state === 'PENDING') continue;
    // An empty body means the reviewer only left inline comments; those arrive via threads.
    if (BOT_AUTHORS.has(author) || !review.body?.trim() || isFactoryOwnComment(review.body)) continue;
    comments.push({
      id: String(review.id),
      source: 'REVIEW_BODY',
      author,
      body: review.body,
      createdAt: review.submittedAt,
      reviewState: review.state,
    });
  }

  // Inline threads are only exposed through the GraphQL API, not `gh pr view --json`.
  const threads = await fetchReviewThreads(repoPath, prNumber);
  for (const thread of threads) {
    if (thread.resolved && !options.includeResolved) continue;
    for (const comment of thread.comments) {
      if (BOT_AUTHORS.has(comment.author) || isFactoryOwnComment(comment.body)) continue;
      comments.push({ ...comment, resolved: thread.resolved });
    }
  }

  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    headBranch: pr.headRefName,
    baseBranch: pr.baseRefName,
    comments,
    ...(pr.headRefOid ? { headSha: pr.headRefOid } : {}),
    ...(pr.isDraft === undefined ? {} : { isDraft: pr.isDraft }),
    ...(pr.isCrossRepository === undefined ? {} : { isCrossRepository: pr.isCrossRepository }),
    ...(pr.mergeable ? { mergeable: pr.mergeable } : {}),
    ...(pr.mergeStateStatus ? { mergeState: pr.mergeStateStatus } : {}),
    reviewDecision: pr.reviewDecision ?? '',
    checks: summarizeChecks(pr.statusCheckRollup),
  };
}

interface ReviewThread {
  id: string;
  resolved: boolean;
  comments: PullRequestComment[];
}

/**
 * `owner/name` of a checkout, cached for the life of the process. The watcher asks about every
 * open pull request each minute; the owner of a repository does not change between two of them,
 * so asking GitHub once per repository instead of once per pull request saves a third of the calls.
 */
const repoIdentityCache = new Map<string, Promise<{ owner: { login: string }; name: string }>>();

function repoIdentity(repoPath: string): Promise<{ owner: { login: string }; name: string }> {
  let pending = repoIdentityCache.get(repoPath);
  if (!pending) {
    pending = ghJson<{ owner: { login: string }; name: string }>(repoPath, [
      'repo',
      'view',
      '--json',
      'owner,name',
    ]);
    // A failure must not be remembered: the next check should try again.
    pending.catch(() => repoIdentityCache.delete(repoPath));
    repoIdentityCache.set(repoPath, pending);
  }
  return pending;
}

/** Reads inline review threads via GraphQL, which is the only API that exposes them. */
async function fetchReviewThreads(repoPath: string, prNumber: number): Promise<ReviewThread[]> {
  const query = `
    query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 50) {
                nodes {
                  id
                  body
                  createdAt
                  path
                  line
                  state
                  author { login }
                  pullRequestReview { state }
                }
              }
            }
          }
        }
      }
    }`;

  const repo = await repoIdentity(repoPath);

  try {
    const response = await ghJson<{
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Array<{
                id: string;
                isResolved: boolean;
                comments: {
                  nodes: Array<{
                    id: string;
                    body: string;
                    createdAt: string;
                    path: string | null;
                    line: number | null;
                    /** SUBMITTED, or PENDING while it belongs to a review its author has not submitted. */
                    state?: string;
                    author: { login: string } | null;
                    pullRequestReview?: { state: string } | null;
                  }>;
                };
              }>;
            };
          };
        };
      };
    }>(repoPath, [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-F',
      `owner=${repo.owner.login}`,
      '-F',
      `repo=${repo.name}`,
      '-F',
      `pr=${prNumber}`,
    ]);

    return (response.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).map((thread) => ({
      id: thread.id,
      resolved: thread.isResolved,
      comments: thread.comments.nodes
        // Draft comments (an unsubmitted review) are not feedback yet - see the reviews loop above.
        .filter((comment) => comment.state !== 'PENDING' && comment.pullRequestReview?.state !== 'PENDING')
        .map((comment) => ({
        id: comment.id,
        source: 'REVIEW_THREAD' as const,
        threadId: thread.id,
        author: comment.author?.login ?? 'unknown',
        body: comment.body,
        createdAt: comment.createdAt,
        ...(comment.path ? { path: comment.path } : {}),
        ...(comment.line === null ? {} : { line: comment.line }),
      })),
    }));
  } catch {
    // Inline threads are a bonus: a GraphQL failure must not break the whole feedback run.
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Posts a comment on the pull-request conversation, labelled as written by the factory
 * (see {@link signAsAi}) so it can be told apart from what the account owner types, and tagged so
 * later feedback runs skip it instead of triaging the factory's own words as reviewer feedback.
 */
export async function postPullRequestComment(
  repoPath: string,
  prNumber: number,
  body: string,
): Promise<{ posted: boolean; reason?: string }> {
  if (!(await hasGh(repoPath))) {
    return { posted: false, reason: 'GitHub CLI (`gh`) not found.' };
  }

  const result = await runProcess('gh', ['pr', 'comment', String(prNumber), '--body', signAsAi(body)], {
    cwd: repoPath,
    trusted: true,
    timeoutMs: 60_000,
  });

  return result.ok
    ? { posted: true }
    : {
        posted: false,
        reason: `gh pr comment failed (exit ${result.exitCode}): ${
          result.stderr.trim() || result.stdout.trim()
        }`,
      };
}

/** What a thread reply needs in order to stay readable if it has to go out as a conversation comment. */
export interface ThreadReplyContext {
  author?: string;
  /** `path:line` of the inline comment being answered. */
  location?: string;
  /** First line of the comment being answered. */
  excerpt?: string;
}

/**
 * Which pull request a review thread belongs to, and whether the signed-in user has a pending
 * (unsubmitted) review on it. A read-only query; `null` when it cannot be answered.
 */
async function probeThread(
  repoPath: string,
  threadId: string,
): Promise<{ number: number; hasPendingReview: boolean } | null> {
  const query = `
    query($threadId: ID!) {
      node(id: $threadId) {
        ... on PullRequestReviewThread {
          pullRequest {
            number
            reviews(states: [PENDING], first: 1) { nodes { id } }
          }
        }
      }
    }`;
  try {
    const response = await ghJson<{
      data?: { node?: { pullRequest?: { number: number; reviews?: { nodes?: unknown[] } } } | null };
    }>(repoPath, ['api', 'graphql', '-f', `query=${query}`, '-f', `threadId=${threadId}`]);
    const pullRequest = response.data?.node?.pullRequest;
    if (!pullRequest) return null;
    return { number: pullRequest.number, hasPendingReview: (pullRequest.reviews?.nodes?.length ?? 0) > 0 };
  } catch {
    return null;
  }
}

/**
 * Replies inside an inline review thread, keeping the answer next to the code it concerns, labelled
 * as written by the factory.
 *
 * GitHub attaches a reply made through the API to the signed-in user's *pending* review when they
 * have one: the reply then stays invisible to everybody else until the user submits their draft,
 * and lands inside it. (Seen for real: a reply posted while the user was still drafting.) So when
 * a pending review exists the answer goes out as a conversation comment instead, quoting what it
 * answers. If the check itself fails, the normal in-thread reply is used.
 */
export async function replyToReviewThread(
  repoPath: string,
  threadId: string,
  body: string,
  context: ThreadReplyContext = {},
): Promise<{ posted: boolean; reason?: string }> {
  const probe = await probeThread(repoPath, threadId);
  if (probe?.hasPendingReview) {
    const whose = context.author ? `@${context.author}'s ` : '';
    const where = context.location ? ` on \`${context.location}\`` : '';
    const quote = context.excerpt ? `\n> ${context.excerpt}\n` : '';
    return await postPullRequestComment(
      repoPath,
      probe.number,
      `↪ In reply to ${whose}inline comment${where}:${quote}\n${body}`,
    );
  }

  const mutation = `
    mutation($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
        comment { id }
      }
    }`;

  // `-f` (a raw string), not `-F`: `-F` interprets values - one starting with "@" would be read as
  // a file name, and "true" / "123" would be converted - which a free-text reply must never be.
  const result = await runProcess(
    'gh',
    ['api', 'graphql', '-f', `query=${mutation}`, '-f', `threadId=${threadId}`, '-f', `body=${signAsAi(body)}`],
    { cwd: repoPath, trusted: true, timeoutMs: 60_000 },
  );

  return result.ok
    ? { posted: true }
    : {
        posted: false,
        reason: `Thread reply failed (exit ${result.exitCode}): ${
          result.stderr.trim() || result.stdout.trim()
        }`,
      };
}

/** Resolves an inline thread once the requested change has actually been made. */
export async function resolveReviewThread(
  repoPath: string,
  threadId: string,
): Promise<{ resolved: boolean; reason?: string }> {
  const mutation = `
    mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { isResolved }
      }
    }`;

  const result = await runProcess(
    'gh',
    ['api', 'graphql', '-f', `query=${mutation}`, '-F', `threadId=${threadId}`],
    { cwd: repoPath, trusted: true, timeoutMs: 60_000 },
  );

  return result.ok
    ? { resolved: true }
    : {
        resolved: false,
        reason: `Thread resolve failed (exit ${result.exitCode}): ${
          result.stderr.trim() || result.stdout.trim()
        }`,
      };
}

/** Finds the open pull request for a branch, so feedback runs can take just a branch name. */
export async function findPullRequestForBranch(
  repoPath: string,
  branch: string,
): Promise<number | null> {
  try {
    const list = await ghJson<Array<{ number: number }>>(repoPath, [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'number',
    ]);
    return list[0]?.number ?? null;
  } catch {
    return null;
  }
}
