import { useEffect, useState } from 'react';

interface RunStep {
  step: string;
  attempt: number;
  status: string;
  durationMs: number;
  artifact?: string;
}

interface RunDetailsProps {
  runId: string;
  onClose: () => void;
}

const AGENT_LABELS: Record<string, string> = {
  'pm-architect': 'PM Architect',
  'developer': 'Developer',
  'qa-tester': 'QA Tester',
  'triage': 'Triage',
  'reviewer': 'Code Reviewer',
  'security': 'Security Audit',
  'documentation': 'Documentation',
};

const AGENT_ICONS: Record<string, string> = {
  'pm-architect': '📋',
  'developer': '💻',
  'qa-tester': '🧪',
  'triage': '🔍',
  'reviewer': '👀',
  'security': '🔒',
  'documentation': '📝',
};

/** Turn raw factory errors into a friendlier, actionable message. */
function humanizeError(raw: string): string {
  const msg = raw.trim();

  if (/has uncommitted changes/i.test(msg)) {
    return (
      'The target repository has uncommitted changes.\n\n' +
      'The factory needs a clean git baseline so it can produce a reviewable diff. ' +
      'Commit or stash your changes in the repository, then run the task again.'
    );
  }

  if (/session limit|usage limit|rate.?limit/i.test(msg)) {
    return (
      'Claude subscription usage limit reached.\n\n' +
      'You are still signed in — you have simply used up your quota for the current window. ' +
      'Wait for the limit to reset (the message usually says when, e.g. "resets 10:10pm") and run again. ' +
      'The run can also be resumed later with:\n' +
      'npm run factory -- resume --run-id <runId>'
    );
  }

  if (/No runnable verification configured/i.test(msg)) {
    return (
      'No test command could be detected for this repository.\n\n' +
      'Add a known build manifest (package.json, pom.xml, go.mod, ...) at the repo root or a ' +
      'subproject, or pass an explicit test command in Settings.'
    );
  }

  return msg;
}

export function RunDetails({ runId, onClose }: RunDetailsProps) {
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<{
    task: string;
    status: string;
    duration?: number;
    tokens?: number;
    error?: string;
    branch?: string;
  } | null>(null);
  const [found, setFound] = useState(true);

  useEffect(() => {
    loadRunDetails();
  }, [runId]);

  const loadRunDetails = async () => {
    setLoading(true);
    try {
      const run = await window.api.invoke('factory:get', runId);
      if (run) {
        setFound(true);
        setSummary({
          task: run.task,
          status: run.status,
          duration: run.tokens?.total,
          tokens: run.tokens?.total,
          error: run.error,
          branch: run.branch,
        });
        
        // Use the real steps from summary.json
        if (run.steps) {
          setSteps(run.steps);
        }
      } else {
        setFound(false);
      }
    } catch (error) {
      console.error('Failed to load run details:', error);
      setFound(false);
    } finally {
      setLoading(false);
    }
  };

  const isFailed = summary?.status === 'FAILED' || summary?.status === 'failed';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-3xl max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Run Details
            </h2>
            <p className="text-sm text-slate-500">{runId}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(80vh-120px)]">
          {loading ? (
            <div className="text-center text-slate-500 py-8">Loading run details...</div>
          ) : !found ? (
            <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-4">
              <p className="text-yellow-800 dark:text-yellow-200 text-sm">
                No record found for this run on disk. It may have failed before the factory
                created its trace directory, or its logs were cleaned up.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Summary */}
              {summary && (
                <div className="bg-slate-50 dark:bg-slate-900 rounded-lg p-4">
                  <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                    Task
                  </h3>
                  <p className="text-slate-900 dark:text-slate-100">{summary.task}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-slate-500">
                    <span>Status: {summary.status}</span>
                    {summary.branch && <span>Branch: {summary.branch}</span>}
                    {summary.tokens ? <span>Tokens: {summary.tokens}</span> : null}
                  </div>
                </div>
              )}

              {/* Failure reason */}
              {isFailed && (
                <div className="border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-red-700 dark:text-red-300 mb-2">
                    ✗ Why it failed
                  </h3>
                  <p className="text-sm text-red-800 dark:text-red-200 whitespace-pre-wrap break-words">
                    {summary?.error
                      ? humanizeError(summary.error)
                      : 'The run failed and did not record a reason.'}
                  </p>
                </div>
              )}

              {/* Steps */}
              <div>
                <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">
                  Execution Steps
                </h3>
                {steps.length === 0 ? (
                  <div className="bg-slate-50 dark:bg-slate-900 rounded-lg p-4">
                    <p className="text-slate-600 dark:text-slate-400 text-sm">
                      {isFailed
                        ? 'The run failed before any execution step completed — see the reason above.'
                        : steps.length === 0 && summary
                        ? 'No execution steps recorded for this run.'
                        : 'No execution steps available for this run.'}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {steps.map((step, idx) => {
                    const isSuccess = step.status === 'COMPLETED' || step.status === 'PASS' || step.status.includes('APPROVED');
                    const isFailed = step.status === 'FAILED' || step.status.includes('FAILED');
                    const isRetry = step.status.includes('RETRY') || step.status.includes('CHANGES_REQUESTED');
                    
                    return (
                      <div
                        key={`${step.step}-${step.attempt}-${idx}`}
                        className={`flex items-center gap-4 p-3 rounded-lg ${
                          isSuccess
                            ? 'bg-green-50 dark:bg-green-900/20'
                            : isFailed
                            ? 'bg-red-50 dark:bg-red-900/20'
                            : isRetry
                            ? 'bg-yellow-50 dark:bg-yellow-900/20'
                            : 'bg-slate-50 dark:bg-slate-900'
                        }`}
                      >
                        <span className="text-2xl">{AGENT_ICONS[step.step] || '🤖'}</span>
                        <div className="flex-1">
                          <div className="font-medium text-slate-900 dark:text-slate-100">
                            {AGENT_LABELS[step.step] || step.step}
                            {step.attempt > 1 && (
                              <span className="ml-2 text-xs text-slate-500">(Attempt {step.attempt})</span>
                            )}
                          </div>
                          <div className="text-sm text-slate-500">
                            {step.durationMs ? `${(step.durationMs / 1000).toFixed(1)}s` : ''}
                            {step.status && ` • ${step.status}`}
                          </div>
                        </div>
                        <div>
                          {isSuccess && (
                            <span className="text-green-600 dark:text-green-400">✓</span>
                          )}
                          {isFailed && (
                            <span className="text-red-600 dark:text-red-400">✗</span>
                          )}
                          {isRetry && (
                            <span className="text-yellow-600 dark:text-yellow-400">⟳</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
