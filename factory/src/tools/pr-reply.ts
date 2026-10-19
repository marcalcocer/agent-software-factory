/**
 * Answering reviewers on GitHub - the one place that decides *which* answers may be posted when.
 *
 * A reply is only honest when it can be given now:
 *  - a QUESTION or a note can be answered at triage time;
 *  - "I'll change that" before anything was changed (or if the round later fails, or the human
 *    declines to push) is a promise on GitHub that nothing backs up, so replies to requested
 *    changes are posted by the round that makes the change, after it is pushed;
 *  - a disagreement is for a human to answer.
 */
import { postPullRequestComment, replyToReviewThread } from './github-tools.ts';
import { markCommentsHandled, pullRequestKey } from './pr-registry.ts';
import type { RevisionComment } from '../utils/schemas.ts';

/** Triage categories whose reply is posted right away. */
export const ANSWERED_AT_TRIAGE: ReadonlySet<string> = new Set(['QUESTION', 'PRAISE_OR_NOTE']);

/** A comment together with the reply the triage agent drafted for it. */
export type CommentWithReply = RevisionComment & { reply?: string };

export interface PostRepliesResult {
  posted: number;
  /** One reason per reply that could not be posted. */
  failures: string[];
  /** Ids of the comments that now have their answer on GitHub. */
  answeredIds: string[];
}

/** Posts one reply where the comment lives: inline comments in their own thread, the rest in the conversation. */
export async function postReplyFor(
  repoPath: string,
  prNumber: number,
  comment: CommentWithReply,
  body: string,
): Promise<{ posted: boolean; reason?: string }> {
  if (comment.source === 'REVIEW_THREAD' && comment.threadId) {
    return await replyToReviewThread(repoPath, comment.threadId, body, {
      author: comment.author,
      ...(comment.path ? { location: `${comment.path}${comment.line ? `:${comment.line}` : ''}` } : {}),
      excerpt: (comment.body.trim().split('\n')[0] ?? '').slice(0, 160),
    });
  }
  return await postPullRequestComment(repoPath, prNumber, body);
}

/**
 * Posts the drafted replies that can be given now and records those comments as handled, so a
 * question that has been answered stops counting as pending feedback.
 */
export async function postTriageReplies(
  repoPath: string,
  prNumber: number,
  comments: CommentWithReply[],
): Promise<PostRepliesResult> {
  const result: PostRepliesResult = { posted: 0, failures: [], answeredIds: [] };

  for (const comment of comments) {
    const reply = comment.reply?.trim();
    if (!reply || !comment.category || !ANSWERED_AT_TRIAGE.has(comment.category)) continue;

    const outcome = await postReplyFor(repoPath, prNumber, comment, reply);
    if (outcome.posted) {
      result.posted += 1;
      result.answeredIds.push(comment.id);
    } else {
      result.failures.push(outcome.reason ?? `Reply to ${comment.id} was not posted.`);
    }
  }

  await markCommentsHandled(pullRequestKey(repoPath, prNumber), result.answeredIds);
  return result;
}
