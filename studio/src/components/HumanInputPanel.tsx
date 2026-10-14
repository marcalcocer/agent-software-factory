import { useState } from 'react';
import type { PendingInput } from '../../shared/types';

interface HumanInputPanelProps {
  input: PendingInput;
  onSubmit: (answer: {
    clarifications?: string;
    decision?: 'ACKNOWLEDGE' | 'ABORT';
    guidance?: string;
    approvePush?: boolean;
    approvePullRequest?: boolean;
  }) => void;
  submitting?: boolean;
}

/**
 * Jenkins-style input gate: the pipeline is paused and waits for a human decision.
 *
 * Renders a different form per gate reason, mirroring the workflow's resume schema:
 *   - CLARIFICATION_REQUIRED     answers to the architect's questions
 *   - DELIVERY_APPROVAL_REQUIRED push / open-PR approval
 *   - ESCALATION_REQUIRED        abort or acknowledge, plus optional guidance
 */
export function HumanInputPanel({ input, onSubmit, submitting = false }: HumanInputPanelProps) {
  const [clarifications, setClarifications] = useState('');
  const [guidance, setGuidance] = useState('');

  const header = (
    <div className="flex items-start gap-3">
      <div className="w-10 h-10 rounded-full bg-amber-400 flex items-center justify-center text-xl flex-shrink-0">
        ⏸
      </div>
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-white">Waiting for your input</h3>
        <p className="text-xs text-amber-100/80">
          The pipeline is paused at step <span className="font-mono">{input.step}</span>
        </p>
      </div>
    </div>
  );

  return (
    <div className="rounded-lg overflow-hidden border-2 border-amber-400 shadow-lg">
      <div className="bg-gradient-to-r from-amber-600 to-orange-600 px-5 py-4">{header}</div>

      <div className="bg-white dark:bg-slate-800 p-5 space-y-4">
        {input.reason === 'CLARIFICATION_REQUIRED' && (
          <>
            {input.planSummary && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
                  Plan so far
                </h4>
                <p className="text-sm text-slate-700 dark:text-slate-300">{input.planSummary}</p>
              </div>
            )}

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                The architect needs answers
              </h4>
              <ul className="space-y-1.5">
                {(input.questions ?? []).map((question, index) => (
                  <li key={index} className="flex gap-2 text-sm text-slate-700 dark:text-slate-300">
                    <span className="text-amber-600 dark:text-amber-400 font-semibold">{index + 1}.</span>
                    <span>{question}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
                Your answers
              </label>
              <textarea
                autoFocus
                value={clarifications}
                onChange={(e) => setClarifications(e.target.value)}
                rows={5}
                placeholder="Answer the questions above. The architect re-plans with this context."
                className="w-full px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>

            <div className="flex justify-end">
              <button
                disabled={submitting || clarifications.trim() === ''}
                onClick={() => onSubmit({ clarifications: clarifications.trim() })}
                className="px-4 py-2 text-sm font-medium text-white bg-amber-600 rounded-md hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? 'Resuming...' : 'Submit answers & continue'}
              </button>
            </div>
          </>
        )}

        {input.reason === 'DELIVERY_APPROVAL_REQUIRED' && (
          <>
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-md p-3">
              <p className="text-sm text-green-800 dark:text-green-200">
                ✓ All quality gates passed and the work is committed locally.
              </p>
            </div>

            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Branch
                </dt>
                <dd className="font-mono text-slate-800 dark:text-slate-200 break-all">{input.branch}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Target
                </dt>
                <dd className="font-mono text-slate-800 dark:text-slate-200 break-all">{input.baseBranch}</dd>
              </div>
              {input.commitSha && (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Commit
                  </dt>
                  <dd className="font-mono text-slate-800 dark:text-slate-200">
                    {input.commitSha.slice(0, 8)}
                  </dd>
                </div>
              )}
              {input.filesChanged !== undefined && (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Files changed
                  </dt>
                  <dd className="text-slate-800 dark:text-slate-200">{input.filesChanged}</dd>
                </div>
              )}
            </dl>

            {input.pullRequestTitle && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
                  Proposed pull request
                </h4>
                <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                  {input.pullRequestTitle}
                </p>
              </div>
            )}

            <div className="pt-1">
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">
                How should this be delivered?
              </h4>
              <div className="flex flex-wrap gap-2">
                <button
                  disabled={submitting}
                  onClick={() => onSubmit({ approvePush: true, approvePullRequest: true })}
                  className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-md hover:bg-green-700 disabled:opacity-50 transition-colors"
                >
                  Push & open pull request
                </button>
                <button
                  disabled={submitting}
                  onClick={() => onSubmit({ approvePush: true, approvePullRequest: false })}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  Push only
                </button>
                <button
                  disabled={submitting}
                  onClick={() => onSubmit({ approvePush: false, approvePullRequest: false })}
                  className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-md hover:bg-slate-50 dark:hover:bg-slate-600 disabled:opacity-50 transition-colors"
                >
                  Keep local
                </button>
              </div>
            </div>
          </>
        )}

        {input.reason === 'ESCALATION_REQUIRED' && (
          <>
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-3 space-y-1">
              <p className="text-sm font-medium text-red-800 dark:text-red-200">
                The factory could not finish on its own.
              </p>
              {input.escalationReason && (
                <p className="text-sm text-red-700 dark:text-red-300">{input.escalationReason}</p>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-3 text-sm">
              {input.rootCause && (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Root cause
                  </dt>
                  <dd className="text-slate-800 dark:text-slate-200">{input.rootCause}</dd>
                </div>
              )}
              {input.attempt !== undefined && (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Attempts
                  </dt>
                  <dd className="text-slate-800 dark:text-slate-200">
                    {input.attempt} of {input.maxAttempts ?? '?'}
                  </dd>
                </div>
              )}
            </dl>

            {input.question && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
                  Question for you
                </h4>
                <p className="text-sm text-slate-700 dark:text-slate-300">{input.question}</p>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
                Guidance (optional)
              </label>
              <textarea
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
                rows={3}
                placeholder="Recorded with your decision and reused as context on the next run."
                className="w-full px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <button
                disabled={submitting}
                onClick={() =>
                  onSubmit({
                    decision: 'ABORT',
                    ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
                  })
                }
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                Abort run
              </button>
              <button
                disabled={submitting}
                onClick={() =>
                  onSubmit({
                    decision: 'ACKNOWLEDGE',
                    ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
                  })
                }
                className="px-4 py-2 text-sm font-medium text-white bg-amber-600 rounded-md hover:bg-amber-700 disabled:opacity-50 transition-colors"
              >
                Acknowledge & close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
