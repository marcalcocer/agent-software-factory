import { useEffect, useState } from 'react';
import type {
  PrComment,
  PrMergeDraft,
  PrMergeNotice,
  PrMergeResult,
  PrScopeComment,
  PrWatchState,
  PrWatchStatus,
  ScopeDecisionResult,
  SettledPhase,
  WatchedPullRequest,
} from '../../shared/types';
import { WorkingCopyLine } from './WorkingCopy';

/* -------------------------------------------------------------------------- */
/* Small pieces                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Triage categories whose reply can be posted straight away. Mirrors
 * `ANSWERED_AT_TRIAGE` in factory/src/tools/pr-reply.ts - it only decides whether the "post
 * replies" button is offered, so a drift would show a button that posts nothing, never a wrong post.
 */
const ANSWERED_AT_TRIAGE = new Set(['QUESTION', 'PRAISE_OR_NOTE']);

const STATUS_STYLE: Record<PrWatchStatus, { label: string; chip: string; pulse?: boolean }> = {
  'awaiting-scope': { label: 'Choose where it goes', chip: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200' },
  idle: { label: 'Up to date', chip: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200' },
  pending: { label: 'New comments', chip: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' },
  triaging: { label: 'Reading comments', chip: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200', pulse: true },
  triaged: { label: 'Triaged', chip: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200' },
  revising: { label: 'Round running', chip: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200', pulse: true },
  'awaiting-approval': { label: 'Approve the push', chip: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200' },
  blocked: { label: 'Needs attention', chip: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200' },
  error: { label: 'Error', chip: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200' },
};

const ACTION_LABEL: Record<string, string> = {
  RERUN_IMPLEMENTATION: 'Code changes requested',
  RERUN_PLANNING: 'The plan needs to change',
  REPLY_ONLY: 'No code changes needed',
  ESCALATE_HUMAN: 'Needs your decision',
  NO_FEEDBACK: 'Nothing to act on',
};

const samePath = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** "20 s ago" - re-rendered on a timer by the caller. */
function ago(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/**
 * A turning ring. Unlike a pulsing dot it is hard to miss, which is the point: it marks the states
 * where the app is busy and there is nothing for the user to do ("Reading 1 comment...").
 * Decorative - the words next to it say what is happening - and still when motion is reduced.
 */
function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block w-4 h-4 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin motion-reduce:animate-none ${className}`}
    />
  );
}

/** A button's label while its action is under way. */
function Busy({ children }: { children: string }) {
  return (
    <>
      <Spinner className="w-3.5 h-3.5" />
      {children}
    </>
  );
}

/** The app itself is working on this pull request (as opposed to waiting for the user). */
const isWorking = (status: PrWatchStatus): boolean => status === 'triaging' || status === 'revising';

function StatusChip({ status }: { status: PrWatchStatus }) {
  const style = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${style.chip}`}>
      {style.pulse && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
      {style.label}
    </span>
  );
}

function CommentList({ comments }: { comments: PrComment[] }) {
  const shown = comments.slice(0, 5);
  return (
    <ul className="space-y-1.5" data-testid="pending-comments">
      {shown.map((comment) => (
        <li key={comment.id} className="text-sm rounded border border-slate-200 dark:border-slate-700 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-medium text-slate-800 dark:text-slate-200">@{comment.author}</span>
            {comment.path && (
              <span className="font-mono">
                {comment.path}
                {comment.line ? `:${comment.line}` : ''}
              </span>
            )}
            {comment.reviewState === 'CHANGES_REQUESTED' && (
              <span className="px-1.5 rounded bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200">changes requested</span>
            )}
            {comment.fresh && (
              <span className="px-1.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">new</span>
            )}
          </div>
          <p className="mt-0.5 text-slate-700 dark:text-slate-300 break-words">
            {comment.body.replace(/\s+/g, ' ').slice(0, 200)}
            {comment.body.length > 200 ? '...' : ''}
          </p>
        </li>
      ))}
      {comments.length > shown.length && (
        <li className="text-xs text-slate-500 dark:text-slate-400">and {comments.length - shown.length} more</li>
      )}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* One pull request                                                            */
/* -------------------------------------------------------------------------- */

interface CardActions {
  onTriage: (key: string) => Promise<void>;
  onRevise: (
    key: string,
    options?: { task?: string; action?: 'RERUN_IMPLEMENTATION' | 'RERUN_PLANNING' },
  ) => Promise<void>;
  onDismiss: (key: string) => Promise<void>;
  onPostReplies: (key: string) => Promise<void>;
  onOpenRun: (runId: string) => void;
  /** Says where review comments about a later phase go: a phase of the roadmap, a new one, or this pull request. */
  onDecideScope: (
    key: string,
    decisions: Array<{ commentId: string; decision: 'DEFER' | 'DO_NOW'; targetPhase?: string | null }>,
  ) => Promise<ScopeDecisionResult[]>;
  /** "I reviewed it and have no comments" - for the commit the card showed. */
  onApprove: (key: string, headSha: string) => Promise<void>;
  onWithdrawApproval: (key: string) => Promise<void>;
  /** Has the factory write the commit message of the squash. Changes nothing on GitHub. */
  onMergeDraft: (key: string) => Promise<PrMergeDraft>;
  onMerge: (key: string, input: { subject: string; body: string; deleteBranch: boolean }) => Promise<PrMergeResult>;
}

/* -------------------------------------------------------------------------- */
/* Merging: approve, then squash                                               */
/* -------------------------------------------------------------------------- */

const shortSha = (sha: string): string => sha.slice(0, 7);

/** "18 Oct, 14:32" */
function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const SUBJECT_TARGET = 72;

interface MergeSectionProps {
  pr: WatchedPullRequest;
  actions: CardActions;
  busy: string | null;
  run: (label: string, work: () => Promise<void>) => Promise<void>;
  buttonBase: string;
}

/**
 * What a pull request with no open comments offers: the human's approval ("I reviewed it and I have
 * no comments") and, once given, the squash merge. The approval belongs to one commit: if the branch
 * moves, the question is asked again.
 */
function MergeSection({ pr, actions, busy, run, buttonBase }: MergeSectionProps) {
  const { merge } = pr;
  const [draft, setDraft] = useState<PrMergeDraft | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [deleteBranch, setDeleteBranch] = useState(true);

  // A message written for one commit must not outlive it, nor an approval that was withdrawn.
  const approvedSha = merge.approval?.headSha ?? null;
  useEffect(() => {
    setDraft(null);
  }, [approvedSha]);

  const writeDraft = () =>
    run('draft', async () => {
      const next = await actions.onMergeDraft(pr.key);
      setDraft(next);
      setSubject(next.subject);
      setBody(next.body);
    });

  const panel = 'rounded-md border p-3 space-y-2';
  const quiet = 'text-xs text-slate-500 dark:text-slate-400';
  const secondary = `${buttonBase} border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700`;

  const warnings =
    merge.warnings.length > 0 ? (
      <ul className="list-disc list-inside text-xs text-amber-700 dark:text-amber-300" data-testid="merge-warnings">
        {merge.warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    ) : null;

  // 1. Something stands in the way (conflicts, a draft, ...): say what, offer nothing.
  if (merge.blockers.length > 0) {
    return (
      <div
        data-testid="merge-blocked"
        className={`${panel} border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20`}
      >
        <p className="text-sm font-medium text-amber-900 dark:text-amber-200">It cannot be merged yet</p>
        <ul className="list-disc list-inside text-sm text-amber-800 dark:text-amber-300">
          {merge.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      </div>
    );
  }

  // 2. Not approved yet: the question.
  if (!merge.approval) {
    return (
      <div data-testid="merge-approve" className={`${panel} border-slate-200 dark:border-slate-700`}>
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">Do you approve this pull request?</p>
        <p className={quiet}>
          Read it on{' '}
          <a href={pr.url} target="_blank" rel="noopener noreferrer" className="underline">
            GitHub
          </a>
          . If you have no comments, approve it - that unlocks the merge. Your approval is for commit{' '}
          <span className="font-mono">{merge.headSha ? shortSha(merge.headSha) : '?'}</span> only: if anything is pushed
          after it, you will be asked again.
        </p>
        {merge.approvalOutdated && (
          <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="approval-outdated">
            This pull request changed after you approved it. Review it again.
          </p>
        )}
        {warnings}
        <button
          disabled={busy !== null || !merge.headSha}
          onClick={() => run('approve', () => actions.onApprove(pr.key, merge.headSha!))}
          className={`${buttonBase} text-white bg-blue-600 hover:bg-blue-700`}
        >
          {busy === 'approve' ? <Busy>Approving...</Busy> : 'Yes - I reviewed it and I have no comments'}
        </button>
      </div>
    );
  }

  // 3. Approved, and no message prepared yet.
  if (!draft) {
    return (
      <div
        data-testid="merge-approved"
        className={`${panel} border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20`}
      >
        <p className="text-sm text-green-900 dark:text-green-200">
          ✓ You approved this pull request{' '}
          <span className={quiet}>
            (commit <span className="font-mono">{shortSha(merge.approval.headSha)}</span>, {when(merge.approval.approvedAt)})
          </span>
        </p>
        {warnings}
        <div className="flex flex-wrap gap-2">
          <button
            disabled={busy !== null}
            onClick={writeDraft}
            className={`${buttonBase} text-white bg-green-600 hover:bg-green-700`}
          >
            {busy === 'draft' ? <Busy>Writing the commit message...</Busy> : 'Merge with squash...'}
          </button>
          <button
            disabled={busy !== null}
            onClick={() => run('withdraw', () => actions.onWithdrawApproval(pr.key))}
            className={secondary}
          >
            Withdraw approval
          </button>
        </div>
      </div>
    );
  }

  // 4. The squash, ready to be checked and confirmed.
  const { stats } = draft;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <div data-testid="merge-preview" className={`${panel} border-green-200 dark:border-green-800 bg-white dark:bg-slate-900/40`}>
      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
        Squash {plural(stats.commits, 'commit', 'commits')} into one on{' '}
        <span className="font-mono">{draft.pullRequest.baseBranch}</span>
      </p>
      <p className={quiet}>
        {plural(stats.files, 'file', 'files')} changed, <span className="text-green-700 dark:text-green-400">+{stats.additions}</span>{' '}
        <span className="text-red-700 dark:text-red-400">-{stats.deletions}</span>. This is the message the commit will have -
        edit it if you like.
      </p>

      <div className="space-y-1">
        <label htmlFor={`squash-subject-${pr.number}`} className="block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Subject
        </label>
        <input
          id={`squash-subject-${pr.number}`}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="w-full px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {subject.length > SUBJECT_TARGET && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {subject.length} characters: subjects are easier to read in the history when they stay under {SUBJECT_TARGET}.
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label htmlFor={`squash-body-${pr.number}`} className="block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Description
        </label>
        <textarea
          id={`squash-body-${pr.number}`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          className="w-full px-3 py-2 text-sm font-mono rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {draft.source === 'agent' ? (
        <p className={quiet} data-testid="draft-source">
          Written by the AI from the final diff (what will really land), not from the individual commits. Read it before
          merging.
        </p>
      ) : (
        <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="draft-source">
          {draft.note}
        </p>
      )}
      {draft.source === 'agent' && draft.note && <p className="text-xs text-amber-700 dark:text-amber-300">{draft.note}</p>}
      {warnings}

      <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          checked={deleteBranch}
          onChange={(e) => setDeleteBranch(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Delete the branch <span className="font-mono">{draft.pullRequest.headBranch}</span> after merging
        </span>
      </label>
      <p className={quiet}>
        Afterwards your working copy goes back to <span className="font-mono">{draft.pullRequest.baseBranch}</span> (unless
        something is using it), so the next task starts from there.
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          disabled={busy !== null || subject.trim() === ''}
          onClick={() => run('merge', async () => void (await actions.onMerge(pr.key, { subject, body, deleteBranch })))}
          className={`${buttonBase} text-white bg-green-600 hover:bg-green-700`}
        >
          {busy === 'merge' ? <Busy>Merging...</Busy> : 'Squash and merge'}
        </button>
        <button disabled={busy !== null} onClick={() => setDraft(null)} className={secondary}>
          Cancel
        </button>
        {draft.source === 'fallback' && !draft.dryRun && (
          <button disabled={busy !== null} onClick={writeDraft} className={secondary}>
            {busy === 'draft' ? <Busy>Writing...</Busy> : 'Try the AI again'}
          </button>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Review comments that ask for more than this pull request                    */
/* -------------------------------------------------------------------------- */

interface ScopeSectionProps {
  pr: WatchedPullRequest;
  actions: CardActions;
  busy: string | null;
  run: (label: string, work: () => Promise<void>) => Promise<void>;
  buttonBase: string;
}

/**
 * Comments the triage thinks belong to a later phase. They are not built in this pull request by
 * accident, and not lost: the user says where each goes - a phase of the roadmap (the one the triage
 * suggests is one click), a phase of its own, or this pull request after all.
 */
function ScopeSection({ pr, actions, busy, run, buttonBase }: ScopeSectionProps) {
  const scope = pr.scope!;
  const planned = (pr.roadmap?.phases ?? []).filter((phase) => phase.status === 'PLANNED');
  const [chosen, setChosen] = useState<Record<string, string>>({});

  const decide = (commentId: string, decision: 'DEFER' | 'DO_NOW', targetPhase?: string) =>
    run(`scope:${commentId}`, async () => {
      const results = await actions.onDecideScope(pr.key, [
        { commentId, decision, ...(targetPhase === undefined ? {} : { targetPhase }) },
      ]);
      const failed = results.find((result) => !result.ok);
      if (failed) throw new Error(failed.error ?? 'It could not be decided.');
    });

  const secondary = `${buttonBase} border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700`;
  const primary = `${buttonBase} text-white bg-purple-600 hover:bg-purple-700`;

  const suggestion = (comment: PrScopeComment) => {
    if (comment.suggestedPhaseId === 'NEW') return { label: 'Make it a phase of its own', target: 'NEW' };
    const phase = planned.find((candidate) => candidate.id === comment.suggestedPhaseId);
    return phase ? { label: `Defer to phase ${phase.ordinal}: ${phase.title}`, target: phase.id } : null;
  };

  return (
    <div data-testid="scope-section" className="rounded-md border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/20 p-3 space-y-3">
      <div>
        <p className="text-sm font-medium text-purple-900 dark:text-purple-200">
          {scope.undecided.length === 1 ? 'This comment asks' : 'These comments ask'} for more than this pull request
        </p>
        <p className="text-xs text-purple-800/80 dark:text-purple-300/80">
          {pr.roadmap
            ? `This is phase ${pr.roadmap.ordinal} of ${pr.roadmap.total} of "${pr.roadmap.title}". Nothing starts until you say where each goes.`
            : 'Nothing starts until you say where each goes.'}
        </p>
      </div>

      <ul className="space-y-3">
        {scope.undecided.map((comment) => {
          const suggested = suggestion(comment);
          const picked = chosen[comment.id] ?? '';
          return (
            <li key={comment.id} data-testid={`scope-comment-${comment.id}`} className="space-y-2 rounded border border-purple-200 dark:border-purple-800 bg-white dark:bg-slate-800 p-2.5">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                <span className="font-medium text-slate-800 dark:text-slate-200">@{comment.author}</span>
                {comment.path && (
                  <span className="font-mono">
                    {' '}
                    {comment.path}
                    {comment.line ? `:${comment.line}` : ''}
                  </span>
                )}
              </div>
              <p className="text-sm text-slate-700 dark:text-slate-300 break-words">
                {comment.body.replace(/\s+/g, ' ').slice(0, 280)}
                {comment.body.length > 280 ? '...' : ''}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {suggested && (
                  <button disabled={busy !== null} onClick={() => decide(comment.id, 'DEFER', suggested.target)} className={primary}>
                    {busy === `scope:${comment.id}` ? <Busy>Saving...</Busy> : suggested.label}
                  </button>
                )}
                <select
                  aria-label={`Defer comment from @${comment.author} to another phase`}
                  value={picked}
                  onChange={(event) => setChosen({ ...chosen, [comment.id]: event.target.value })}
                  className="px-2 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                >
                  <option value="">{suggested ? 'Another phase...' : 'Defer to...'}</option>
                  {planned.map((phase) => (
                    <option key={phase.id} value={phase.id}>
                      Phase {phase.ordinal}: {phase.title}
                    </option>
                  ))}
                  <option value="NEW">A phase of its own</option>
                </select>
                {picked !== '' && (
                  <button disabled={busy !== null} onClick={() => decide(comment.id, 'DEFER', picked)} className={secondary}>
                    Defer
                  </button>
                )}
                <button disabled={busy !== null} onClick={() => decide(comment.id, 'DO_NOW')} className={secondary}>
                  Do it in this pull request
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {scope.doNow.length > 0 && (
        <p className="text-xs text-purple-800 dark:text-purple-300" data-testid="scope-do-now">
          {scope.doNow.length === 1 ? '1 comment goes' : `${scope.doNow.length} comments go`} into this pull request: the next round plans{' '}
          {scope.doNow.length === 1 ? 'it' : 'them'} in.
        </p>
      )}
    </div>
  );
}

function PullRequestCard({ pr, actions }: { pr: WatchedPullRequest; actions: CardActions }) {
  const triage = pr.triage ?? null;
  const needsCode = triage?.action === 'RERUN_IMPLEMENTATION' || triage?.action === 'RERUN_PLANNING';

  // The follow-up task is the triage agent's draft: the reviewer's words are authoritative, so it is editable.
  const [task, setTask] = useState(triage?.followUpTask ?? '');
  const [plan, setPlan] = useState<'RERUN_IMPLEMENTATION' | 'RERUN_PLANNING'>(
    triage?.action === 'RERUN_PLANNING' ? 'RERUN_PLANNING' : 'RERUN_IMPLEMENTATION',
  );
  useEffect(() => {
    setTask(triage?.followUpTask ?? '');
    setPlan(triage?.action === 'RERUN_PLANNING' ? 'RERUN_PLANNING' : 'RERUN_IMPLEMENTATION');
  }, [triage?.runId, triage?.followUpTask, triage?.action]);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (err) {
      // Electron wraps an error thrown in the main process as "Error invoking remote method '...': Error: <message>".
      setError(
        (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
      );
    } finally {
      setBusy(null);
    }
  };

  const repliable = (triage?.items ?? []).filter(
    (item) => item.reply?.trim() && ANSWERED_AT_TRIAGE.has(item.category),
  ).length;
  const nextRound = pr.round + 1;
  const inProgress = pr.status === 'revising' || pr.status === 'awaiting-approval';
  const working = isWorking(pr.status);
  const buttonBase =
    'inline-flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div
      data-testid={`pr-card-${pr.number}`}
      className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 space-y-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-slate-900 dark:text-slate-100 hover:underline"
        >
          #{pr.number} {pr.title}
        </a>
        <StatusChip status={pr.status} />
        {pr.status === 'idle' && pr.merge.approval && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200">
            Approved
          </span>
        )}
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Round {pr.round} · <span className="font-mono">{pr.headBranch}</span> → <span className="font-mono">{pr.baseBranch}</span>
        </span>
      </div>

      <p
        role="status"
        className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"
        data-testid="pr-message"
      >
        {working && <Spinner className="text-blue-600 dark:text-blue-400" />}
        <span>{pr.message}</span>
      </p>

      {/* Where the code is, so it can be looked at by hand. */}
      {pr.workCopy && <WorkingCopyLine workCopy={pr.workCopy} rootRunId={pr.rootRunId} />}

      {pr.status === 'idle' && <MergeSection pr={pr} actions={actions} busy={busy} run={run} buttonBase={buttonBase} />}

      {pr.status === 'awaiting-scope' && pr.scope && <ScopeSection pr={pr} actions={actions} busy={busy} run={run} buttonBase={buttonBase} />}

      {pr.pending.length > 0 && !inProgress && (
        <CommentList
          // The ones the section above asks about are listed there, with their buttons.
          comments={pr.status === 'awaiting-scope' && pr.scope ? pr.pending.filter((comment) => !pr.scope!.undecided.some((asked) => asked.id === comment.id)) : pr.pending}
        />
      )}

      {triage && pr.status === 'triaged' && (
        <div className="space-y-2">
          <div className="text-sm text-slate-700 dark:text-slate-300">
            <span className="font-medium">{ACTION_LABEL[triage.action] ?? triage.action}.</span> {triage.summary}
          </div>
          {triage.blockers.length > 0 && (
            <ul className="list-disc list-inside text-sm text-red-700 dark:text-red-300">
              {triage.blockers.map((blocker, i) => (
                <li key={i}>{blocker}</li>
              ))}
            </ul>
          )}
          {triage.items.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {triage.items.map((item) => (
                <li
                  key={item.commentId}
                  title={item.excerpt}
                  className="px-2 py-0.5 text-xs rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200"
                >
                  @{item.author}: {item.category.replace(/_/g, ' ').toLowerCase()}
                </li>
              ))}
            </ul>
          )}

          {needsCode && (
            <div className="space-y-2">
              <label htmlFor={`task-${pr.number}`} className="block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                What this round will do
              </label>
              <textarea
                id={`task-${pr.number}`}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                Plan:
                <select
                  aria-label="Plan for the round"
                  value={plan}
                  onChange={(e) => setPlan(e.target.value as typeof plan)}
                  className="px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                >
                  <option value="RERUN_IMPLEMENTATION">Keep the existing plan (fastest)</option>
                  <option value="RERUN_PLANNING">Plan again first</option>
                </select>
              </label>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Continues this task on <span className="font-mono">{pr.headBranch}</span>: the new commit updates pull request #{pr.number}{' '}
                and the round is linked to the run that opened it.
              </p>
            </div>
          )}
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* `empty:hidden`: a pull request with nothing to do here (it is waiting for the user's approval,
          which has its own panel above) would otherwise leave a blank row at the bottom of the card. */}
      <div className="flex flex-wrap gap-2 empty:hidden">
        {(pr.status === 'pending' || pr.status === 'error') && pr.pending.length > 0 && (
          <button
            disabled={busy !== null}
            onClick={() => run('triage', () => actions.onTriage(pr.key))}
            className={`${buttonBase} text-white bg-blue-600 hover:bg-blue-700`}
          >
            {busy === 'triage' ? <Busy>Reading...</Busy> : pr.status === 'error' ? 'Try again' : 'Read the comments'}
          </button>
        )}

        {pr.status === 'triaged' && needsCode && (
          <button
            disabled={busy !== null || task.trim() === ''}
            onClick={() => run('revise', () => actions.onRevise(pr.key, { task: task.trim(), action: plan }))}
            className={`${buttonBase} text-white bg-green-600 hover:bg-green-700`}
          >
            {busy === 'revise' ? (
              <Busy>Starting...</Busy>
            ) : triage && triage.blockers.length > 0 ? (
              `Start round ${nextRound} anyway`
            ) : (
              `Start round ${nextRound}`
            )}
          </button>
        )}

        {pr.status === 'blocked' && !pr.revisionRunId && triage && needsCode && (
          <button
            disabled={busy !== null}
            onClick={() => run('revise', () => actions.onRevise(pr.key, { task: task.trim() || undefined, action: plan }))}
            className={`${buttonBase} text-white bg-green-600 hover:bg-green-700`}
          >
            Start round {nextRound}
          </button>
        )}

        {/* Only for a round that failed. One that is waiting for the user cannot be "started again":
            it is still using the working copy, so the only thing to do is open it and answer. */}
        {pr.status === 'blocked' && pr.retryable && pr.revisionRunId && triage && needsCode && (
          <button
            disabled={busy !== null}
            onClick={() => run('revise', () => actions.onRevise(pr.key, { task: task.trim() || undefined, action: plan }))}
            className={`${buttonBase} border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700`}
          >
            {busy === 'revise' ? <Busy>Starting...</Busy> : 'Start it again'}
          </button>
        )}

        {pr.status === 'triaged' && repliable > 0 && (
          <button
            disabled={busy !== null}
            onClick={() => run('replies', () => actions.onPostReplies(pr.key))}
            className={`${buttonBase} border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700`}
          >
            {busy === 'replies' ? <Busy>Posting...</Busy> : `Answer ${repliable} question${repliable === 1 ? '' : 's'} on GitHub`}
          </button>
        )}

        {pr.revisionRunId && (
          <button
            onClick={() => actions.onOpenRun(pr.revisionRunId!)}
            className={`${buttonBase} ${
              pr.status === 'awaiting-approval'
                ? 'text-white bg-orange-600 hover:bg-orange-700'
                : 'border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700'
            }`}
          >
            {pr.status === 'awaiting-approval' ? 'Review and approve' : 'Open the round'}
          </button>
        )}

        {pr.pending.length > 0 && !inProgress && pr.status !== 'triaging' && (
          <button
            disabled={busy !== null}
            onClick={() => run('dismiss', () => actions.onDismiss(pr.key))}
            title="Never act on these comments"
            className={`${buttonBase} text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700`}
          >
            Dismiss comments
          </button>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                       */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* What just happened to a pull request that is no longer there                */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of a merge. A merged pull request leaves the list, so without this the user would
 * never see what became of it - least of all the things that were deliberately not done (a
 * working copy that stayed where it was, a branch that was kept).
 */
/** Where the project stands now that a phase is delivered. */
function PhaseOutcome({ phase }: { phase: SettledPhase }) {
  return (
    <p data-testid="phase-outcome">
      Phase {phase.ordinal} of {phase.total} of <span className="font-medium">{phase.initiativeTitle}</span> is delivered.{' '}
      {phase.next
        ? `Phase ${phase.next.ordinal} ("${phase.next.title}") is next - start it from the roadmap below.`
        : phase.initiativeDone
          ? 'The project is finished.'
          : 'No other phase can start yet.'}
    </p>
  );
}

function MergeNoticeCard({ notice, onDismiss }: { notice: PrMergeNotice; onDismiss: (id: string) => void }) {
  const { result } = notice;
  const repoUrl = notice.url.replace(/\/pull\/\d+.*$/, '');
  const tone = result.merged
    ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-900 dark:text-green-200'
    : 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-blue-900 dark:text-blue-200';

  return (
    <div role="status" data-testid="merge-notice" className={`rounded-md border px-3 py-2 text-sm space-y-1 ${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">
          {result.merged ? '✓ Merged' : 'Dry run - nothing was merged'}{' '}
          <a href={notice.url} target="_blank" rel="noopener noreferrer" className="underline">
            #{notice.number} {notice.title}
          </a>
        </p>
        <button
          onClick={() => onDismiss(notice.id)}
          aria-label="Dismiss this message"
          className="shrink-0 -mt-0.5 px-1.5 rounded hover:bg-black/5 dark:hover:bg-white/10"
        >
          ×
        </button>
      </div>
      {result.merged && (
        <p>
          Squashed into <span className="font-mono">{result.baseBranch ?? 'the base branch'}</span>
          {result.mergeCommit && (
            <>
              {' '}as{' '}
              <a href={`${repoUrl}/commit/${result.mergeCommit}`} target="_blank" rel="noopener noreferrer" className="font-mono underline">
                {shortSha(result.mergeCommit)}
              </a>
            </>
          )}
          .
        </p>
      )}
      {!result.merged && result.reason && <p>{result.reason}</p>}
      {result.merged && result.phase && <PhaseOutcome phase={result.phase} />}
      {result.notes.length > 0 && (
        <ul className="list-disc list-inside text-xs opacity-90">
          {result.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                       */
/* -------------------------------------------------------------------------- */

interface PullRequestsPanelProps extends CardActions {
  /** Only the pull requests of this repository are shown. */
  repoPath: string;
  state: PrWatchState | null;
  onRefresh: () => void;
  /** Merges the user just did (or rehearsed), newest first. */
  notices: PrMergeNotice[];
  onDismissNotice: (id: string) => void;
}

export function PullRequestsPanel({ repoPath, state, onRefresh, notices, onDismissNotice, ...actions }: PullRequestsPanelProps) {
  const now = useNow(15_000);

  if (!state) return null;

  // Every open pull request is a card: one without open comments is exactly the one that can be
  // merged, so it cannot be tucked away. (The watcher already lists the ones that need attention first.)
  const mine = state.pullRequests.filter((pr) => samePath(pr.repoPath, repoPath));
  const attention = mine.filter((pr) => pr.status !== 'idle');
  const mineNotices = notices.filter((notice) => samePath(notice.repoPath, repoPath));
  const { settings } = state;

  const headline = !settings.enabled
    ? 'Automatic checks are off (turn them on in Settings)'
    : mine.length === 0
      ? 'No open pull requests from the factory yet'
      : `Watching ${mine.length} open pull request${mine.length === 1 ? '' : 's'}`;

  return (
    <section
      aria-label="Pull requests"
      className="bg-white dark:bg-slate-800 rounded-lg shadow-sm overflow-hidden"
      data-testid="pull-requests-panel"
    >
      <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Pull requests</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400" data-testid="pr-headline">
            {headline}
            {settings.enabled && ` · ${state.checking ? 'checking...' : `checked ${ago(state.lastCheckedAt, now)}`}`}
            {attention.length > 0 && ` · ${attention.length} need${attention.length === 1 ? 's' : ''} attention`}
          </p>
        </div>
        <button
          onClick={onRefresh}
          disabled={state.checking}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50"
        >
          {state.checking ? <Busy>Checking...</Busy> : 'Check now'}
        </button>
      </div>

      {state.error && (
        <div role="alert" className="mx-4 mb-3 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          Could not check GitHub: {state.error}
        </div>
      )}

      {mineNotices.length > 0 && (
        <div className="px-4 pb-3 space-y-2">
          {mineNotices.map((notice) => (
            <MergeNoticeCard key={notice.id} notice={notice} onDismiss={onDismissNotice} />
          ))}
        </div>
      )}

      {mine.length > 0 && (
        <div className="px-4 pb-4 space-y-3">
          {mine.map((pr) => (
            <PullRequestCard key={pr.key} pr={pr} actions={actions} />
          ))}
        </div>
      )}
    </section>
  );
}
