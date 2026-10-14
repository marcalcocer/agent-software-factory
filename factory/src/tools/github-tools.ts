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
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

async function hasGh(cwd: string): Promise<boolean> {
  const result = await runProcess('gh', ['--version'], { cwd, trusted: true, timeoutMs: 15_000 });
  return result.ok;
}

/** Runs a `gh` command and parses its stdout as JSON. */
async function ghJson<T>(cwd: string, args: string[]): Promise<T> {
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

/** Marker appended to every factory reply, so its own comments are never re-triaged. */
export const FACTORY_REPLY_MARKER = '<!-- agent-software-factory -->';

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
    'number,title,state,url,headRefName,baseRefName,comments,reviews',
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
  };
}

interface ReviewThread {
  id: string;
  resolved: boolean;
  comments: PullRequestComment[];
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
                  author { login }
                }
              }
            }
          }
        }
      }
    }`;

  const repo = await ghJson<{ owner: { login: string }; name: string }>(repoPath, [
    'repo',
    'view',
    '--json',
    'owner,name',
  ]);

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
                    author: { login: string } | null;
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
      comments: thread.comments.nodes.map((comment) => ({
        id: comment.id,
        source: 'REVIEW_THREAD' as const,
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
 * Posts a comment on the pull-request conversation.
 *
 * The body is tagged with `FACTORY_REPLY_MARKER` so later feedback runs skip it instead of
 * triaging the factory's own words as new reviewer feedback.
 */
export async function postPullRequestComment(
  repoPath: string,
  prNumber: number,
  body: string,
): Promise<{ posted: boolean; reason?: string }> {
  if (!(await hasGh(repoPath))) {
    return { posted: false, reason: 'GitHub CLI (`gh`) not found.' };
  }

  const result = await runProcess(
    'gh',
    ['pr', 'comment', String(prNumber), '--body', `${body}\n\n${FACTORY_REPLY_MARKER}`],
    { cwd: repoPath, trusted: true, timeoutMs: 60_000 },
  );

  return result.ok
    ? { posted: true }
    : {
        posted: false,
        reason: `gh pr comment failed (exit ${result.exitCode}): ${
          result.stderr.trim() || result.stdout.trim()
        }`,
      };
}

/** Replies inside an inline review thread, keeping the answer next to the code it concerns. */
export async function replyToReviewThread(
  repoPath: string,
  threadId: string,
  body: string,
): Promise<{ posted: boolean; reason?: string }> {
  const mutation = `
    mutation($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
        comment { id }
      }
    }`;

  const result = await runProcess(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      `query=${mutation}`,
      '-F',
      `threadId=${threadId}`,
      '-F',
      `body=${body}\n\n${FACTORY_REPLY_MARKER}`,
    ],
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
