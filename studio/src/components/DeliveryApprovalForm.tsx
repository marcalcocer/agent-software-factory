import { useMemo, useState } from 'react';
import type { DeliveryEdits, PendingInput } from '../../shared/types';
import { branchNameProblem } from '../../shared/gitRef';

/** GitHub rejects pull-request titles longer than this. */
const MAX_TITLE_LENGTH = 256;

export interface DeliveryAnswer {
  approvePush: boolean;
  approvePullRequest: boolean;
  edits?: DeliveryEdits;
}

interface DeliveryApprovalFormProps {
  input: PendingInput;
  submitting: boolean;
  onSubmit: (answer: DeliveryAnswer) => void;
}

const fieldLabel =
  'block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1';
const fieldBase =
  'w-full px-3 py-2 text-sm rounded-md border bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 ' +
  'focus:outline-none focus:ring-2 focus:ring-amber-500';
const fieldOk = 'border-slate-300 dark:border-slate-600';
const fieldBad = 'border-red-400 dark:border-red-500';
const fieldLocked =
  'w-full px-3 py-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 ' +
  'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 cursor-not-allowed';

/**
 * The delivery approval gate: review - and change - what is about to be published.
 *
 * The commit message, branch name, pull-request title and description are all editable. Two of
 * them are locked once the work is already on the remote (rewriting a pushed commit would need
 * a force-push, renaming a pushed branch would leave the old one behind); the factory says so
 * and shows why instead of silently ignoring the edit.
 */
export function DeliveryApprovalForm({ input, submitting, onSubmit }: DeliveryApprovalFormProps) {
  const initial = useMemo(
    () => ({
      branch: input.branch ?? '',
      commitMessage: input.commitMessage ?? '',
      title: input.pullRequestTitle ?? '',
      body: input.pullRequestBody ?? '',
    }),
    [input],
  );

  const [branch, setBranch] = useState(initial.branch);
  const [commitMessage, setCommitMessage] = useState(initial.commitMessage);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);

  // A further round on an open pull request: pushing updates it, so there is no PR to describe.
  const existing = input.existingPullRequest;

  // Only an explicit `true` unlocks these: a gate raised by an older factory has no such flag.
  const commitEditable = input.commitEditable === true;
  const branchEditable = input.branchEditable === true;

  const changed = {
    branch: branchEditable && branch !== initial.branch,
    commit: commitEditable && commitMessage !== initial.commitMessage,
    title: title !== initial.title,
    body: body !== initial.body,
  };
  const anyChange = changed.branch || changed.commit || changed.title || changed.body;

  const branchError = branchEditable ? branchNameProblem(branch) : null;
  const commitError = commitEditable && commitMessage.trim() === '' ? 'The commit message cannot be empty.' : null;
  const titleError =
    existing
      ? null
      : title.trim() === ''
        ? 'The pull request needs a title.'
        : title.length > MAX_TITLE_LENGTH
          ? `GitHub limits titles to ${MAX_TITLE_LENGTH} characters.`
          : null;

  const localProblem = branchError ?? commitError;

  const reset = () => {
    setBranch(initial.branch);
    setCommitMessage(initial.commitMessage);
    setTitle(initial.title);
    setBody(initial.body);
  };

  /**
   * Always the full final values of every editable field - never a diff - so that the last
   * answer describes the whole choice and a retry can pre-fill the form from it.
   */
  const edits = (): DeliveryEdits => ({
    ...(commitEditable ? { commitMessage } : {}),
    ...(branchEditable ? { branchName: branch } : {}),
    // The title and description belong to a pull request that already exists: not ours to rewrite.
    ...(existing ? {} : { pullRequestTitle: title, pullRequestBody: body }),
  });

  const submit = (approvePush: boolean, approvePullRequest: boolean) =>
    onSubmit({ approvePush, approvePullRequest, edits: edits() });

  const canOpenPullRequest = !submitting && !localProblem && !titleError;
  const canPushOnly = !submitting && !localProblem;

  return (
    <>
      <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-md p-3">
        <p className="text-sm text-green-800 dark:text-green-200">
          {existing ? (
            <>
              ✓ The changes the review asked for passed every gate and are committed locally.
              Pushing them <strong>updates pull request #{existing.number}</strong> - no new pull
              request is opened.
            </>
          ) : (
            <>
              ✓ All quality gates passed and the work is committed locally. Review it, change anything
              you want, then decide how to deliver it.
            </>
          )}
        </p>
      </div>

      {input.pullRequestTextNote && (
        <div
          role="note"
          data-testid="text-note"
          className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-md p-3 text-sm text-amber-800 dark:text-amber-200"
        >
          ✎ {input.pullRequestTextNote}
        </div>
      )}

      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className={fieldLabel}>Target branch</dt>
          <dd className="font-mono text-slate-800 dark:text-slate-200 break-all">{input.baseBranch}</dd>
        </div>
        {input.commitSha && (
          <div>
            <dt className={fieldLabel}>Commit</dt>
            <dd className="font-mono text-slate-800 dark:text-slate-200">{input.commitSha.slice(0, 8)}</dd>
          </div>
        )}
        {input.filesChanged !== undefined && (
          <div>
            <dt className={fieldLabel}>Files changed</dt>
            <dd className="text-slate-800 dark:text-slate-200">{input.filesChanged}</dd>
          </div>
        )}
      </dl>

      {/* Branch */}
      <div>
        <label htmlFor="delivery-branch" className={fieldLabel}>
          Branch {changed.branch && <span className="normal-case text-amber-600">· edited</span>}
        </label>
        {branchEditable ? (
          <input
            id="delivery-branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            spellCheck={false}
            className={`${fieldBase} font-mono ${branchError ? fieldBad : fieldOk}`}
          />
        ) : (
          <input id="delivery-branch" value={input.branch ?? ''} readOnly disabled className={`${fieldLocked} font-mono`} />
        )}
        {branchError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{branchError}</p>}
        {!branchEditable && input.branchLockedReason && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">🔒 {input.branchLockedReason}</p>
        )}
      </div>

      {/* Commit message */}
      <div>
        <label htmlFor="delivery-commit" className={fieldLabel}>
          Commit message {changed.commit && <span className="normal-case text-amber-600">· edited</span>}
        </label>
        {commitEditable ? (
          <textarea
            id="delivery-commit"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            rows={3}
            spellCheck={false}
            className={`${fieldBase} font-mono ${commitError ? fieldBad : fieldOk}`}
          />
        ) : (
          <textarea id="delivery-commit" value={input.commitMessage ?? ''} readOnly disabled rows={2} className={`${fieldLocked} font-mono`} />
        )}
        {commitError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{commitError}</p>}
        {!commitEditable && input.commitLockedReason && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">🔒 {input.commitLockedReason}</p>
        )}
      </div>

      {!existing && (
        <>
      {/* Pull request */}
        <div>
          <label htmlFor="delivery-title" className={fieldLabel}>
            Pull request title {changed.title && <span className="normal-case text-amber-600">· edited</span>}
          </label>
          <input
            id="delivery-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={`${fieldBase} ${titleError ? fieldBad : fieldOk}`}
          />
          {titleError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{titleError}</p>}
        </div>
  
        <div>
          <label htmlFor="delivery-body" className={fieldLabel}>
            Pull request description{' '}
            {changed.body && <span className="normal-case text-amber-600">· edited</span>}
          </label>
          <textarea
            id="delivery-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={9}
            spellCheck={false}
            className={`${fieldBase} ${fieldOk} font-mono text-xs leading-relaxed`}
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Markdown. Shown on GitHub exactly as written here.</p>
        </div>
  
        {(input.pullRequestLabels?.length ?? 0) > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-slate-500 dark:text-slate-400">Labels:</span>
            {input.pullRequestLabels!.map((label) => (
              <span key={label} className="px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200">
                {label}
              </span>
            ))}
            <span className="text-slate-400 dark:text-slate-500">(labels the repository does not define are skipped)</span>
          </div>
        )}
        </>
      )}

      <div className="pt-1">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">How should this be delivered?</h4>
          {anyChange && (
            <button
              type="button"
              onClick={reset}
              disabled={submitting}
              className="text-xs text-amber-700 dark:text-amber-400 hover:underline disabled:opacity-50"
            >
              Reset my changes
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            disabled={!canOpenPullRequest}
            onClick={() => submit(true, true)}
            title={titleError ?? localProblem ?? undefined}
            className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {existing ? `Push to update PR #${existing.number}` : 'Push & open pull request'}
          </button>
          {!existing && (
            <button
              disabled={!canPushOnly}
              onClick={() => submit(true, false)}
              title={localProblem ?? undefined}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Push only
            </button>
          )}
          <button
            disabled={!canPushOnly}
            onClick={() => submit(false, false)}
            title={localProblem ?? undefined}
            className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-md hover:bg-slate-50 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Keep local
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {existing
            ? 'The reviewers are notified by GitHub when the new commit lands.'
            : 'The pull request is opened ready for review, not as a draft.'}
        </p>
      </div>
    </>
  );
}
