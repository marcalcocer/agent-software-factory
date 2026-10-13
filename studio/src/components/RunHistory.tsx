interface Run {
  id: string;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'escalated';
  startTime: Date;
  endTime?: Date;
  summary?: {
    durationMs: number;
    tokensUsed: number;
    stepsCompleted: number;
  };
}

interface RunHistoryProps {
  runs: Run[];
  loading: boolean;
  onSelectRun?: (runId: string) => void;
}

export function RunHistory({ runs, loading, onSelectRun }: RunHistoryProps) {
  if (loading) {
    return (
      <div className="bg-white dark:bg-slate-800 rounded-lg p-6 shadow-sm">
        <div className="text-slate-500">Loading run history...</div>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="bg-white dark:bg-slate-800 rounded-lg p-6 shadow-sm text-center text-slate-500">
        No runs yet. Start by submitting a task above.
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Run History</h3>
      </div>

      <div className="divide-y divide-slate-200 dark:divide-slate-700">
        {runs.map((run) => (
          <div
            key={run.id}
            onClick={() => onSelectRun?.(run.id)}
            className="p-4 hover:bg-slate-50 dark:hover:bg-slate-700/50 cursor-pointer transition-colors"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-start gap-2 mb-1">
                  <p 
                    className="font-medium text-slate-900 dark:text-slate-100 line-clamp-2 flex-1"
                    title={run.task}
                  >
                    {run.task}
                  </p>
                  {run.status === 'running' && (
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200">
                      <span className="animate-pulse">●</span>
                      Running
                    </span>
                  )}
                  {run.status === 'completed' && (
                    <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200">
                      ✓ Completed
                    </span>
                  )}
                  {run.status === 'failed' && (
                    <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200">
                      ✗ Failed
                    </span>
                  )}
                  {run.status === 'escalated' && (
                    <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-yellow-100 dark:bg-yellow-900/40 text-yellow-800 dark:text-yellow-200">
                      ⚠ Escalated
                    </span>
                  )}
                </div>
                <div className="text-sm text-slate-500 dark:text-slate-400">
                  {run.id}
                </div>
              </div>

              <div className="text-right text-sm text-slate-500 dark:text-slate-400 flex-shrink-0">
                <div>
                  {run.startTime.toLocaleDateString()} {run.startTime.toLocaleTimeString()}
                </div>
                {run.summary && (
                  <div className="text-xs mt-1">
                    {run.summary.durationMs}ms • {run.summary.tokensUsed} tokens
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
