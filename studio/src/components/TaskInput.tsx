interface TaskInputProps {
  repoName: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (task: string) => void;
  loading: boolean;
}

export function TaskInput({ repoName, value, onChange, onSubmit, loading }: TaskInputProps) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;

    onSubmit(value);

    // Clear the draft after submission
    onChange('');
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
          What should the factory build or fix?
        </label>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g., Add dark mode with system theme support..."
          disabled={loading}
          rows={5}
          className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed resize-none"
        />
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          The factory will plan, implement, test, review, and document your request.
        </p>
      </div>

      <button
        type="submit"
        disabled={loading || !value.trim()}
        className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium rounded-md transition-colors disabled:cursor-not-allowed"
      >
        {loading ? 'Running Factory...' : 'Run Factory'}
      </button>
    </form>
  );
}
