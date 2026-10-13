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

export function RunDetails({ runId, onClose }: RunDetailsProps) {
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<{
    task: string;
    status: string;
    duration?: number;
    tokens?: number;
  } | null>(null);

  useEffect(() => {
    loadRunDetails();
  }, [runId]);

  const loadRunDetails = async () => {
    setLoading(true);
    try {
      const run = await window.api.invoke('factory:get', runId);
      if (run) {
        setSummary({
          task: run.task,
          status: run.status,
          duration: run.tokens?.total,
          tokens: run.tokens?.total,
        });
        
        // Use the real steps from summary.json
        if (run.steps) {
          setSteps(run.steps);
        }
      }
    } catch (error) {
      console.error('Failed to load run details:', error);
    } finally {
      setLoading(false);
    }
  };

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
          ) : (
            <div className="space-y-6">
              {/* Summary */}
              {summary && (
                <div className="bg-slate-50 dark:bg-slate-900 rounded-lg p-4">
                  <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                    Task
                  </h3>
                  <p className="text-slate-900 dark:text-slate-100">{summary.task}</p>
                  <div className="mt-3 flex items-center gap-4 text-sm text-slate-500">
                    <span>Status: {summary.status}</span>
                    {summary.tokens && <span>Tokens: {summary.tokens}</span>}
                  </div>
                </div>
              )}

              {/* Steps */}
              <div>
                <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">
                  Execution Steps
                </h3>
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
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
