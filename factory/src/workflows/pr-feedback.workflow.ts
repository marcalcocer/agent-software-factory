/**
 * Pull-request feedback workflow - closes the loop between a human reviewer and the factory.
 *
 * ```
 *   GitHub Action / CLI ──▶ fetch-feedback ──▶ triage-feedback ──▶ post-replies ──▶ decide
 *                             (gh CLI)        (feedback-triage)      (gh CLI)         │
 *                                                                                     ▼
 *                                   RERUN_IMPLEMENTATION / RERUN_PLANNING ──▶ follow-up run
 *                                   REPLY_ONLY            ──▶ done, replies posted
 *                                   ESCALATE_HUMAN         ──▶ done, human must decide
 * ```
 *
 * The follow-up run is intentionally *not* started inside this workflow: it returns the task
 * text, and the caller (CLI or Studio) starts a normal factory run with it. That keeps one run
 * equal to one trace directory, so the follow-up is as reviewable as any other run.
 */
import path from 'node:path';

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { getDiff } from '../tools/git-tools.ts';
import { markCommentsHandled, pullRequestKey } from '../tools/pr-registry.ts';
import { ANSWERED_AT_TRIAGE } from '../tools/pr-reply.ts';
import {
  fetchPullRequestReview,
  postPullRequestComment,
  replyToReviewThread,
  type PullRequestComment,
} from '../tools/github-tools.ts';
import {
  appendEvent,
  createRunTrace,
  generateRunId,
  writeArtifact,
  writeContextBlock,
  writeSummary,
} from '../tools/logger-tools.ts';
import { composePrompt, invokeAgent, promptSection } from '../utils/agent-runner.ts';
import { getFactoryConfig, resolveRepoPath } from '../utils/factory-config.ts';
import { feedbackTriageReportSchema } from '../utils/schemas.ts';

/* ========================================================================== */
/* Schemas                                                                     */
/* ========================================================================== */

export const prFeedbackTaskSchema = z.object({
  repo: z.string().describe('Repository name inside the workspace root, or an absolute path.'),
  pullRequest: z.number().int().positive(),
  /** Reply to the reviewer on GitHub. Off by default: posting is a side effect. */
  postReplies: z.boolean().optional(),
  /** Re-triage comments in threads already marked resolved. */
  includeResolved: z.boolean().optional(),
  /** Comments already dealt with in an earlier round: not triaged again. */
  skipCommentIds: z.array(z.string()).optional(),
});

const feedbackContextSchema = z.object({
  runId: z.string(),
  repoPath: z.string(),
  repoName: z.string(),
  pullRequest: z.number().int(),
  prTitle: z.string(),
  prUrl: z.string(),
  headBranch: z.string(),
  baseBranch: z.string(),
  postReplies: z.boolean(),
  comments: z.array(z.custom<PullRequestComment>()),
});

export const prFeedbackResultSchema = z.object({
  runId: z.string(),
  pullRequest: z.number().int(),
  pullRequestUrl: z.string(),
  action: z.enum(['RERUN_IMPLEMENTATION', 'RERUN_PLANNING', 'REPLY_ONLY', 'ESCALATE_HUMAN', 'NO_FEEDBACK']),
  summary: z.string(),
  commentsTriaged: z.number().int(),
  repliesPosted: z.number().int(),
  /** Branch the pull request is opened from - the follow-up run continues on it. */
  headBranch: z.string(),
  /** Branch the pull request targets. */
  baseBranch: z.string(),
  /** Requirement for the follow-up run. Empty when no re-run is needed. */
  followUpTask: z.string(),
  blockers: z.array(z.string()),
  traceDir: z.string(),
});
export type PrFeedbackResult = z.infer<typeof prFeedbackResultSchema>;

/* ========================================================================== */
/* Step 1 - fetch feedback                                                     */
/* ========================================================================== */

const fetchFeedbackStep = createStep({
  id: 'fetch-feedback',
  description: 'Reads the pull request and every unresolved human review comment via the gh CLI.',
  inputSchema: prFeedbackTaskSchema,
  outputSchema: feedbackContextSchema,
  execute: async ({ inputData, runId, mastra }) => {
    const logger = mastra?.getLogger?.();
    const repoPath = resolveRepoPath(inputData.repo, { requireGit: true });
    const repoName = path.basename(repoPath);
    const effectiveRunId = runId ?? generateRunId(`${repoName}-prfeedback`);

    const fetched = await fetchPullRequestReview(repoPath, inputData.pullRequest, {
      ...(inputData.includeResolved === undefined
        ? {}
        : { includeResolved: inputData.includeResolved }),
    });
    // Comments an earlier round already dealt with must not be triaged (and acted on) again.
    const skip = new Set(inputData.skipCommentIds ?? []);
    const review = { ...fetched, comments: fetched.comments.filter((comment) => !skip.has(comment.id)) };

    createRunTrace({
      runId: effectiveRunId,
      task: `PR feedback triage for #${inputData.pullRequest}: ${review.title}`,
      repoPath,
      repoName,
      branch: review.headBranch,
      baseBranch: review.baseBranch,
      models: {},
      // Marked from the first moment, so a triage in progress (or one that died) is never mistaken
      // for a task the user ran.
      kind: 'pr-feedback',
      dryRun: getFactoryConfig().dryRun,
      startedAt: new Date().toISOString(),
    });

    appendEvent(effectiveRunId, {
      type: 'step_completed',
      step: 'fetch-feedback',
      pullRequest: inputData.pullRequest,
      comments: review.comments.length,
    });

    logger?.info?.('[factory] pull-request feedback fetched', {
      runId: effectiveRunId,
      pullRequest: inputData.pullRequest,
      comments: review.comments.length,
    });

    return {
      runId: effectiveRunId,
      repoPath,
      repoName,
      pullRequest: review.number,
      prTitle: review.title,
      prUrl: review.url,
      headBranch: review.headBranch,
      baseBranch: review.baseBranch,
      postReplies: inputData.postReplies ?? false,
      comments: review.comments,
    };
  },
});

/* ========================================================================== */
/* Step 2 - triage feedback                                                    */
/* ========================================================================== */

/** Renders the comments as a numbered block the agent can quote and reference by id. */
function renderComments(comments: PullRequestComment[]): string {
  return comments
    .map((comment, index) => {
      const location =
        comment.path === undefined
          ? ''
          : ` (${comment.path}${comment.line === undefined ? '' : `:${comment.line}`})`;
      const state = comment.reviewState ? ` [${comment.reviewState}]` : '';
      return [
        `### Comment ${index + 1}`,
        `- id: ${comment.id}`,
        `- author: ${comment.author}`,
        `- source: ${comment.source}${location}${state}`,
        '',
        comment.body.trim(),
      ].join('\n');
    })
    .join('\n\n');
}

const triageFeedbackStep = createStep({
  id: 'triage-feedback',
  description:
    'Feedback triage agent: classifies each reviewer comment, routes it to the owning agent ' +
    'and drafts the reply.',
  inputSchema: feedbackContextSchema,
  outputSchema: z.object({
    context: feedbackContextSchema,
    report: feedbackTriageReportSchema,
  }),
  execute: async ({ inputData, mastra }) => {
    const context = inputData;
    const logger = mastra?.getLogger?.();

    // No feedback is a valid outcome, and asking the model about an empty list wastes tokens.
    if (context.comments.length === 0) {
      logger?.info?.('[factory] no unresolved reviewer feedback', { runId: context.runId });
      return {
        context,
        report: {
          overallAction: 'REPLY_ONLY' as const,
          summary: 'No unresolved human feedback on the pull request.',
          items: [],
          taskForNextRun: '',
          blockers: [],
        },
      };
    }

    const diff = await getDiff(context.repoPath, {
      baseRef: context.baseBranch,
      maxChars: 120_000,
    });
    writeContextBlock(context.runId, 'pr-diff', diff.diff);
    writeContextBlock(context.runId, 'pr-comments', renderComments(context.comments));

    const prompt = composePrompt(
      '# Pull request under review',
      '',
      `- Number: #${context.pullRequest}`,
      `- Title: ${context.prTitle}`,
      `- Branch: ${context.headBranch} -> ${context.baseBranch}`,
      `- Repository: ${context.repoPath}`,
      '',
      promptSection('Diff of the branch against its base', diff.diff),
      '',
      '# Unresolved reviewer feedback',
      '',
      renderComments(context.comments),
      '',
      '# Your task',
      '',
      'Classify and route every comment above, then decide the overall action for the run. ' +
        'Use `commentId` values exactly as given so the replies land on the right threads. ' +
        'Read the files the reviewer refers to before classifying.',
    );

    const result = await invokeAgent({
      agent: mastra!.getAgent('feedbackTriageAgent'),
      role: 'feedback-triage',
      step: 'feedback-triage',
      prompt,
      schema: feedbackTriageReportSchema,
      runId: context.runId,
      repoPath: context.repoPath,
      repoName: context.repoName,
      maxSteps: 40,
      dryRunResult: {
        overallAction: 'REPLY_ONLY',
        summary: 'Dry run: feedback was not triaged.',
        items: [],
        taskForNextRun: '',
        blockers: [],
      },
    });

    const report = result.object;

    writeArtifact({
      runId: context.runId,
      step: 'feedback-triage',
      status: report.overallAction,
      model: result.servedByModel,
      durationMs: result.durationMs,
      data: report,
    });

    logger?.info?.('[factory] feedback triage finished', {
      runId: context.runId,
      action: report.overallAction,
      items: report.items.length,
    });

    return { context, report };
  },
});

/* ========================================================================== */
/* Step 3 - post replies and decide                                            */
/* ========================================================================== */

const postRepliesStep = createStep({
  id: 'post-replies',
  description:
    'Posts the drafted replies back to GitHub and returns the follow-up task when the ' +
    'feedback requires another factory run.',
  inputSchema: z.object({
    context: feedbackContextSchema,
    report: feedbackTriageReportSchema,
  }),
  outputSchema: prFeedbackResultSchema,
  execute: async ({ inputData, mastra }) => {
    const { context, report } = inputData;
    const logger = mastra?.getLogger?.();
    const commentsById = new Map(context.comments.map((comment) => [comment.id, comment]));

    let repliesPosted = 0;
    const commentCategory = new Map(report.items.map((item) => [item.commentId, item.category]));
    const commentReply = new Map(report.items.map((item) => [item.commentId, item.reply]));

    // Which replies may be posted now is decided in one place (see `pr-reply.ts`): answers to
    // questions can; "I'll do that" before the change exists cannot.
    const answeredIds: string[] = [];

    if (context.postReplies && !getFactoryConfig().dryRun) {
      for (const item of report.items) {
        if (item.reply.trim() === '' || !ANSWERED_AT_TRIAGE.has(item.category)) continue;

        const comment = commentsById.get(item.commentId);
        // Inline comments are answered in their own thread (by *thread* id - the comment id is
        // not accepted there, which is why these replies never used to arrive); everything else
        // in the conversation.
        const outcome =
          comment?.source === 'REVIEW_THREAD' && comment.threadId
            ? await replyToReviewThread(context.repoPath, comment.threadId, item.reply)
            : await postPullRequestComment(context.repoPath, context.pullRequest, item.reply);

        if (outcome.posted) {
          repliesPosted += 1;
          answeredIds.push(item.commentId);
        } else {
          logger?.warn?.('[factory] reply not posted', { reason: outcome.reason });
        }
      }
    }
    // An answered question stops counting as pending feedback (the reviewer's comment itself stays
    // on GitHub, so without this the watcher would triage and answer it again every minute).
    await markCommentsHandled(pullRequestKey(context.repoPath, context.pullRequest), answeredIds);

    const action: PrFeedbackResult['action'] =
      context.comments.length === 0 ? 'NO_FEEDBACK' : report.overallAction;
    const needsRerun = action === 'RERUN_IMPLEMENTATION' || action === 'RERUN_PLANNING';

    const result = {
      runId: context.runId,
      pullRequest: context.pullRequest,
      pullRequestUrl: context.prUrl,
      action,
      summary: report.summary,
      commentsTriaged: report.items.length,
      repliesPosted,
      headBranch: context.headBranch,
      baseBranch: context.baseBranch,
      followUpTask: needsRerun ? report.taskForNextRun : '',
      blockers: report.blockers,
      traceDir: '',
    };

    writeArtifact({
      runId: context.runId,
      step: 'feedback-delivery',
      status: action,
      data: { repliesPosted, postReplies: context.postReplies, items: report.items.length },
    });

    writeSummary(context.runId, {
      runId: context.runId,
      kind: 'pr-feedback',
      repository: context.repoPath,
      pullRequest: context.pullRequest,
      pullRequestUrl: context.prUrl,
      branch: context.headBranch,
      baseBranch: context.baseBranch,
      status: action,
      summary: report.summary,
      commentsTriaged: report.items.length,
      repliesPosted,
      followUpTask: result.followUpTask,
      blockers: report.blockers,
      items: report.items,
      // The comments themselves, with how each was classified: everything a round (or a later
      // "post the replies") needs, so it does not have to ask GitHub again.
      comments: context.comments.map((comment) => ({
        id: comment.id,
        ...(comment.threadId ? { threadId: comment.threadId } : {}),
        source: comment.source,
        author: comment.author,
        body: comment.body,
        createdAt: comment.createdAt,
        ...(comment.path ? { path: comment.path } : {}),
        ...(comment.line === undefined ? {} : { line: comment.line }),
        ...(commentCategory.get(comment.id) ? { category: commentCategory.get(comment.id) } : {}),
        ...(commentReply.get(comment.id) ? { reply: commentReply.get(comment.id) } : {}),
      })),
      finishedAt: new Date().toISOString(),
    });

    logger?.info?.('[factory] pr feedback run finished', {
      runId: context.runId,
      action,
      repliesPosted,
    });

    return result;
  },
});

/* ========================================================================== */
/* Workflow                                                                    */
/* ========================================================================== */

export const prFeedbackWorkflow = createWorkflow({
  id: 'pr-feedback',
  description:
    'Reads human review comments on a factory pull request, classifies and routes them, posts ' +
    'the replies and reports whether a follow-up run is needed.',
  inputSchema: prFeedbackTaskSchema,
  outputSchema: prFeedbackResultSchema,
})
  .then(fetchFeedbackStep)
  .then(triageFeedbackStep)
  .then(postRepliesStep)
  .commit();
