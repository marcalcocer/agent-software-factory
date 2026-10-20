/**
 * Where a review comment belongs: this pull request, or a later phase of the project.
 *
 * A reviewer often asks for something good that is not for this pull request. Building it here makes the
 * pull request bigger than the phase it is; ignoring it loses it. The triage marks such a comment
 * `FUTURE_PHASE` and says which phase it thinks it belongs to; the USER decides, with a button in the
 * Studio: defer it to a phase (it becomes part of that phase's request, and the comment is dealt with), or
 * do it in this pull request after all (it goes into the next round, planned in).
 *
 * Two parts. `normalizeTriage` is pure: it makes what the triage agent said safe to act on. `decideScope`
 * records the user's decisions and carries them out.
 */
import { clip } from './phasing.ts';
import { withStore, type PhaseRow, type ScopeChoice } from './store.ts';
import { markCommentsHandled, pullRequestKey } from '../tools/pr-registry.ts';
import type { FeedbackTriageReport, RevisionComment } from '../utils/schemas.ts';

/* -------------------------------------------------------------------------- */
/* What the triage said, made safe                                             */
/* -------------------------------------------------------------------------- */

/** Categories that ask for no change to the code in this pull request. */
export const CALLS_FOR_NO_CHANGE: ReadonlySet<string> = new Set(['QUESTION', 'PRAISE_OR_NOTE', 'FUTURE_PHASE', 'BLOCKER_DISAGREEMENT']);

/** The ids of the phases a comment could be deferred to - null when the pull request has no later phase. */
export type RoadmapTargets = { planned: ReadonlySet<string> } | null;

export interface NormalizedTriage {
  report: FeedbackTriageReport;
  /** What was corrected, for the trace. */
  corrections: string[];
}

/**
 * Makes a triage report safe to act on:
 *  - without a roadmap, `FUTURE_PHASE` does not exist: such a comment is new scope for this pull request;
 *  - a `FUTURE_PHASE` comment is routed to nobody, and its target is an id the user can really defer to
 *    (a planned phase of this project) or `NEW` - anything else becomes "unknown", and the user chooses;
 *  - only comments that ask for a change can make a round: a report that says "re-run" when nothing asks
 *    for a change (it was all questions and later-phase requests) is a reply-only report.
 */
export function normalizeTriage(report: FeedbackTriageReport, roadmap: RoadmapTargets): NormalizedTriage {
  const corrections: string[] = [];
  const downgraded: string[] = [];

  const items = report.items.map((item) => {
    if (item.category !== 'FUTURE_PHASE') {
      return item.targetPhase ? { ...item, targetPhase: null } : item;
    }
    if (!roadmap) {
      corrections.push(`Comment ${item.commentId} was called a later-phase request, but this pull request has no later phase: it is new scope for this one.`);
      downgraded.push(item.excerpt);
      return { ...item, category: 'SCOPE_CHANGE' as const, assignTo: 'pm-architect' as const, targetPhase: null };
    }
    const asked = item.targetPhase?.trim() ?? '';
    const target = asked.toUpperCase() === 'NEW' ? 'NEW' : roadmap.planned.has(asked) ? asked : null;
    if (asked !== '' && target === null) {
      corrections.push(`Comment ${item.commentId} named "${asked}" as its phase, which is not a phase it can be deferred to; the user will choose.`);
    }
    return { ...item, assignTo: 'none' as const, targetPhase: target };
  });

  let { overallAction, taskForNextRun, roundTitle } = report;
  // New scope must not be lost because the agent had already answered "reply only" for what it took to be a later phase.
  if (downgraded.length > 0 && overallAction === 'REPLY_ONLY') {
    overallAction = 'RERUN_PLANNING';
    taskForNextRun = `Plan in and address these review comments, which ask for work the plan does not cover:\n${downgraded.map((excerpt) => `- ${excerpt}`).join('\n')}`;
    corrections.push('The triage answered "reply only", but a comment is new scope for this pull request: it needs a round that plans it in.');
  }
  const asksForChange = items.some((item) => !CALLS_FOR_NO_CHANGE.has(item.category));
  if ((overallAction === 'RERUN_IMPLEMENTATION' || overallAction === 'RERUN_PLANNING') && !asksForChange) {
    const blocked = items.some((item) => item.category === 'BLOCKER_DISAGREEMENT');
    corrections.push(
      `The triage asked for another round, but no comment asks for a change${blocked ? ' (one is a disagreement a human must settle)' : ''}.`,
    );
    overallAction = blocked ? 'ESCALATE_HUMAN' : 'REPLY_ONLY';
    taskForNextRun = '';
    roundTitle = undefined;
  }

  // `roundTitle` is rebuilt, not spread: a report that is no longer a round must not keep the round's name.
  const { roundTitle: _named, ...rest } = report;
  return {
    report: { ...rest, items, overallAction, taskForNextRun, ...(roundTitle === undefined ? {} : { roundTitle }) },
    corrections,
  };
}

/* -------------------------------------------------------------------------- */
/* What the user decided                                                       */
/* -------------------------------------------------------------------------- */

export interface ScopeRequest {
  commentId: string;
  decision: ScopeChoice;
  /** DEFER: a planned phase of this project (its id), or `NEW`. Omitted: the one the triage suggested. */
  targetPhase?: string | null | undefined;
}

export interface ScopeResult {
  commentId: string;
  decision: ScopeChoice;
  ok: boolean;
  /** Why it was not carried out, in words for the user. */
  error?: string;
  /** DEFER: where it went. */
  target?: { phaseId: string; ordinal: number; title: string; created: boolean };
  /** Nothing changed: this decision had been taken already. */
  alreadyDecided?: boolean;
  /** DEFER with GitHub replies on: whether the acknowledgement was posted. */
  replied?: boolean;
  replyError?: string;
}

export interface DecideScopeOptions {
  /** The user's repository (what pull requests and projects are filed under). */
  repoPath: string;
  number: number;
  /** The comments of the latest triage, with the category it gave each. */
  comments: RevisionComment[];
  decisions: ScopeRequest[];
  /** Acknowledge a deferral on GitHub. */
  replyOnGitHub?: boolean;
  /** Posts a reply on GitHub; replaceable for tests. */
  reply?: (comment: RevisionComment, body: string) => Promise<{ posted: boolean; reason?: string }>;
}

/** A short name for a phase made of a review comment: its first sentence, kept short. */
export function titleFromComment(body: string): string {
  const first = body.trim().split(/\n/)[0]!.split(/(?<=[.!?])\s/)[0]!;
  const words = first.replace(/^[-*#>\s]+/, '').replace(/[.!?:]+$/, '').trim();
  const title = clip(words, 60).replace(/[\s,;:-]+$/, '');
  return title === '' ? 'Review request' : title.charAt(0).toUpperCase() + title.slice(1);
}

const where = (comment: RevisionComment): string => (comment.path ? ` (${comment.path}${comment.line ? `:${comment.line}` : ''})` : '');

/** What a deferred comment becomes in the phase it goes to: the user's own request, in their words. */
const requestNote = (comment: RevisionComment, number: number): string =>
  `${clip(comment.body, 600)}${where(comment)} - from the review of pull request #${number}`;

export async function decideScope(options: DecideScopeOptions): Promise<{ results: ScopeResult[]; initiativeId: string | null }> {
  const { repoPath, number } = options;
  const key = pullRequestKey(repoPath, number);
  const byId = new Map(options.comments.map((comment) => [comment.id, comment]));
  const results: ScopeResult[] = [];
  const deferred: Array<{ comment: RevisionComment; target: NonNullable<ScopeResult['target']> }> = [];

  const initiativeId = await withStore(async (store) => {
    const from = await store.findPhaseByPullRequest(repoPath, number);
    const initiative = from ? await store.getInitiative(from.initiativeId) : null;
    const earlier = new Map((await store.listScopeDecisions(key)).map((row) => [row.commentId, row]));

    for (const request of options.decisions) {
      const refuse = (error: string) => results.push({ commentId: request.commentId, decision: request.decision, ok: false, error });
      const comment = byId.get(request.commentId);
      if (!comment) {
        refuse('This comment is not part of the latest triage of the pull request. Triage it again first.');
        continue;
      }
      if (!from || !initiative) {
        refuse('This pull request is not a phase of a project, so there is no other phase to decide about.');
        continue;
      }
      const before = earlier.get(request.commentId);

      /* ---- do it in this pull request ---- */
      if (request.decision === 'DO_NOW') {
        if (comment.category !== 'FUTURE_PHASE') {
          refuse('This comment is already part of this pull request; there is nothing to decide.');
          continue;
        }
        if (before?.decision === 'DEFER') {
          const phase = initiative.phases.find((candidate) => candidate.id === before.targetPhaseId);
          refuse(`It was already deferred${phase ? ` to phase ${phase.ordinal} ("${phase.title}")` : ''} and recorded there. Take it out of that phase in the roadmap if you changed your mind.`);
          continue;
        }
        await store.recordScopeDecision({
          prKey: key, commentId: comment.id, initiativeId: initiative.id, fromPhaseId: from.id, targetPhaseId: null, decision: 'DO_NOW', excerpt: clip(comment.body, 200),
        });
        await store.log(initiative.id, 'scope_decided', { pr: number, commentId: comment.id, decision: 'DO_NOW' });
        results.push({ commentId: comment.id, decision: 'DO_NOW', ok: true, ...(before?.decision === 'DO_NOW' ? { alreadyDecided: true } : {}) });
        continue;
      }

      /* ---- defer it ---- */
      const asked = (request.targetPhase ?? comment.targetPhase ?? '').trim();
      if (asked === '') {
        refuse('Say which phase it goes to, or a new one.');
        continue;
      }
      let target: PhaseRow | null = null;
      let created = false;
      if (before?.decision === 'DEFER' && (asked.toUpperCase() === 'NEW' || before.targetPhaseId === asked)) {
        // The same decision again (a second click): nothing more to do.
        target = initiative.phases.find((candidate) => candidate.id === before.targetPhaseId) ?? null;
        if (target) {
          results.push({ commentId: comment.id, decision: 'DEFER', ok: true, alreadyDecided: true, target: { phaseId: target.id, ordinal: target.ordinal, title: target.title, created: false } });
          continue;
        }
      }
      if (asked.toUpperCase() === 'NEW') {
        // Read again: an earlier decision of this same request may have added a phase already.
        const last = Math.max(0, ...((await store.getInitiative(initiative.id))?.phases ?? []).map((candidate) => candidate.ordinal));
        target = await store.addPhase(initiative.id, {
          title: titleFromComment(comment.body),
          goal: clip(comment.body, 400),
          scope: [clip(comment.body, 160)],
          ...(last > 0 ? { dependsOnOrdinals: [last] } : {}),
        });
        created = true;
      } else {
        target = initiative.phases.find((candidate) => candidate.id === asked) ?? null;
        if (!target) {
          refuse(`${asked} is not a phase of this project.`);
          continue;
        }
        if (target.status !== 'PLANNED') {
          refuse(`Phase ${target.ordinal} ("${target.title}") is ${target.status === 'MERGED' ? 'already delivered' : 'not waiting any more'}, so it cannot take new work. Choose a phase that is still planned, or a new one.`);
          continue;
        }
      }

      await store.appendNotes(target.id, [{ source: 'user-request', text: requestNote(comment, number) }]);
      await store.recordScopeDecision({
        prKey: key, commentId: comment.id, initiativeId: initiative.id, fromPhaseId: from.id, targetPhaseId: target.id, decision: 'DEFER', excerpt: clip(comment.body, 200),
      });
      await store.log(initiative.id, 'scope_decided', { pr: number, commentId: comment.id, decision: 'DEFER', phaseId: target.id, created });
      const placed = { phaseId: target.id, ordinal: target.ordinal, title: target.title, created };
      deferred.push({ comment, target: placed });
      results.push({ commentId: comment.id, decision: 'DEFER', ok: true, target: placed });
    }
    return initiative?.id ?? null;
  });

  // A deferred comment is dealt with: it stops counting as pending, and no round will act on it.
  if (deferred.length > 0) await markCommentsHandled(key, deferred.map((entry) => entry.comment.id));

  // The acknowledgement on GitHub - the only thing it hears about the decision.
  if (options.replyOnGitHub && options.reply) {
    for (const { comment, target } of deferred) {
      const body = target.created
        ? `Noted. This is not part of this pull request; it is now a phase of its own in the roadmap ("${target.title}"), where it will be planned.`
        : `Noted. This is not part of this pull request; it goes to phase ${target.ordinal} of the roadmap ("${target.title}"), where it will be planned.`;
      const outcome = await options.reply(comment, body).catch((error: Error) => ({ posted: false, reason: error.message }));
      const result = results.find((candidate) => candidate.commentId === comment.id)!;
      result.replied = outcome.posted;
      if (!outcome.posted) result.replyError = outcome.reason ?? 'The reply was not posted.';
    }
  }

  return { results, initiativeId };
}
