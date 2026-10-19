import { useRef, useState } from 'react';
import { groupRuns } from '../lib/groupRuns';

interface Run {
  id: string;
  title: string;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'escalated';
  startTime: Date;
  endTime?: Date;
  error?: string;
  /** Which task this run belongs to, and which round of it. */
  rootRunId?: string;
  round?: number;
  pullRequestNumber?: number;
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
  onResume?: (runId: string) => void;
  onRename?: (runId: string, title: string) => void;
  onDelete?: (runId: string) => void;
}

export function RunHistory({ runs, loading, onSelectRun, onResume, onRename, onDelete }: RunHistoryProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A single click opens the run details, but delay it briefly so a double-click
  // on the title (rename) can cancel the open.
  const scheduleOpen = (runId: string) => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      onSelectRun?.(runId);
    }, 250);
  };

  const cancelOpen = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };

  const startEdit = (run: Run) => {
    cancelOpen();
    setEditingId(run.id);
    setEditValue(run.title);
  };

  const commitEdit = (run: Run) => {
    const next = editValue.trim();
    if (next && next !== run.title) onRename?.(run.id, next);
    setEditingId(null);
  };

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
        No runs yet. Start by submitting a task below.
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Run History</h3>
      </div>

      <div className="divide-y divide-slate-200 dark:divide-slate-700">
        {groupRuns(runs).map(({ run, nested, rounds }) => (
          <div
            key={run.id}
            onClick={() => {
              if (editingId) return;
              onSelectRun?.(run.id);
            }}
            className={`p-4 hover:bg-slate-50 dark:hover:bg-slate-700/50 cursor-pointer transition-colors ${
              nested ? 'pl-10 bg-slate-50/60 dark:bg-slate-900/30 border-l-4 border-indigo-300 dark:border-indigo-700' : ''
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-start gap-2 mb-1">
                  {editingId === run.id ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => commitEdit(run)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitEdit(run);
                        else if (e.key === 'Escape') setEditingId(null);
                      }}
                      className="flex-1 min-w-0 px-2 py-1 text-sm font-medium rounded border border-blue-400 dark:border-blue-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 outline-none"
                    />
                  ) : (
                    <span
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startEdit(run);
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        scheduleOpen(run.id);
                      }}
                      title={`Double-click to rename\n\n${run.task}`}
                      className="flex-1 min-w-0 truncate font-medium text-slate-900 dark:text-slate-100 cursor-text"
                    >
                      {run.title}
                    </span>
                  )}
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
                {run.round && run.round > 1 ? (
                  <div className="mb-0.5 text-xs font-medium text-indigo-700 dark:text-indigo-300">
                    ↳ Round {run.round} of this task
                    {run.pullRequestNumber ? ` · pull request #${run.pullRequestNumber}` : ''}
                  </div>
                ) : rounds > 1 ? (
                  <div className="mb-0.5 text-xs font-medium text-indigo-700 dark:text-indigo-300">
                    {rounds} rounds · review comments were addressed on the same pull request
                  </div>
                ) : null}
                <div className="text-sm text-slate-500 dark:text-slate-400 truncate">
                  {run.id}
                </div>
                {run.status === 'failed' && (
                  <>
                    {run.error && (
                      <div className="mt-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded px-2 py-1">
                        {run.error}
                      </div>
                    )}
                    {onResume && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onResume(run.id);
                        }}
                        className="mt-2 px-3 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors"
                      >
                        ▶ Retry
                      </button>
                    )}
                  </>
                )}
              </div>

              <div className="flex items-start gap-2">
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
                {onDelete && run.status !== 'running' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(run.id);
                    }}
                    title="Delete this run"
                    className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
