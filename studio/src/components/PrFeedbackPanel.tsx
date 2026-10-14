import { useState } from 'react';

interface PrFeedbackPanelProps {
  repoName: string;
  onSubmit: (prNumber: number, postReplies: boolean, autoRerun: boolean) => void;
  loading: boolean;
}

export function PrFeedbackPanel({ repoName, onSubmit, loading }: PrFeedbackPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [prNumber, setPrNumber] = useState('');
  const [postReplies, setPostReplies] = useState(false);
  const [autoRerun, setAutoRerun] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const num = parseInt(prNumber, 10);
    if (!num || num < 1) return;

    onSubmit(num, postReplies, autoRerun);
  };

  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm overflow-hidden">
      {/* Collapsed header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg
            className={`w-4 h-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
            PR Feedback
          </span>
        </div>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Triage review comments
        </span>
      </button>

      {/* Expanded form */}
      {expanded && (
        <form onSubmit={handleSubmit} className="p-4 space-y-4 border-t border-slate-200 dark:border-slate-700">
          <div className="text-xs text-slate-600 dark:text-slate-400">
            Read GitHub PR review comments, classify them with the triage agent, and optionally
            post replies or start a follow-up run.
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900 dark:text-slate-100 mb-1">
              Pull Request Number
            </label>
            <input
              type="number"
              value={prNumber}
              onChange={(e) => setPrNumber(e.target.value)}
              placeholder="e.g., 42"
              disabled={loading}
              min="1"
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              From {repoName} on GitHub
            </p>
          </div>

          <div className="space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={postReplies}
                onChange={(e) => setPostReplies(e.target.checked)}
                disabled={loading}
                className="mt-0.5 w-4 h-4 text-blue-600 border-slate-300 dark:border-slate-600 rounded focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Post replies to PR
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Publicly visible comments explaining the triage decision
                </div>
              </div>
            </label>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoRerun}
                onChange={(e) => setAutoRerun(e.target.checked)}
                disabled={loading}
                className="mt-0.5 w-4 h-4 text-blue-600 border-slate-300 dark:border-slate-600 rounded focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Auto-rerun factory
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Start a new factory run with the follow-up task (costs tokens)
                </div>
              </div>
            </label>
          </div>

          {(postReplies || autoRerun) && (
            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
              <div className="flex items-start gap-2">
                <svg
                  className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                    clipRule="evenodd"
                  />
                </svg>
                <div className="text-xs text-blue-900 dark:text-blue-200">
                  {postReplies && (
                    <div className="mb-1">
                      <strong>Replies will be visible to reviewers</strong> on GitHub
                    </div>
                  )}
                  {autoRerun && (
                    <div>
                      <strong>A new factory run will start</strong> if the triage suggests
                      actionable changes
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !prNumber || parseInt(prNumber, 10) < 1}
            className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium rounded-md transition-colors disabled:cursor-not-allowed"
          >
            {loading ? 'Triaging Feedback...' : 'Triage Feedback'}
          </button>
        </form>
      )}
    </div>
  );
}
