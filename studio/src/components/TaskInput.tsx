import { useState } from 'react';

interface TaskInputProps {
  repoName: string;
  onSubmit: (task: string, options: TaskOptions) => void;
  loading: boolean;
}

export interface TaskOptions {
  maxAttempts: number;
  dryRun: boolean;
  baseBranch?: string;
}

export function TaskInput({ repoName, onSubmit, loading }: TaskInputProps) {
  const [task, setTask] = useState('');
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [dryRun, setDryRun] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!task.trim()) return;

    onSubmit(task, {
      maxAttempts,
      dryRun,
    });

    // Reset form
    setTask('');
    setMaxAttempts(3);
    setDryRun(false);
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white dark:bg-slate-800 rounded-lg p-6 shadow-sm space-y-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          New Task for {repoName}
        </h3>
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-900 dark:text-slate-100 mb-2">
          Task Description
        </label>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Describe what the factory should build or fix..."
          disabled={loading}
          rows={4}
          className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-900 dark:text-slate-100 mb-2">
            Max Iterations
          </label>
          <input
            type="number"
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(Math.max(1, parseInt(e.target.value) || 1))}
            disabled={loading}
            min="1"
            max="10"
            className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              disabled={loading}
              className="rounded border-slate-300 dark:border-slate-600 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Dry Run
            </span>
          </label>
        </div>
      </div>

      <button
        type="submit"
        disabled={loading || !task.trim()}
        className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium rounded-md transition-colors disabled:cursor-not-allowed"
      >
        {loading ? 'Running...' : 'Run Factory'}
      </button>
    </form>
  );
}
