import type { PipelineConfig } from '../../shared/types';
import { PipelineSelector } from './PipelineSelector';

export type Isolation = 'worktree' | 'in-place';
export type Phasing = 'auto' | 'on' | 'off';

interface TaskInputProps {
  repoName: string;
  /** The repository's folder, for the preview of where an in-place task would work. */
  repoPath?: string;
  /**
   * Where the factory makes checkouts, as it says itself - for the preview of the folder a task would get, and the
   * warning when that is somewhere a restart clears. Absent until the factory has answered.
   */
  places?: { worktreesDir: string; volatile: boolean };
  /** Where the task works: a checkout of its own (default), or the user's repository. */
  isolation: Isolation;
  onIsolationChange: (isolation: Isolation) => void;
  /** Whether the architect may split a big request into phases. */
  phasing: Phasing;
  onPhasingChange: (phasing: Phasing) => void;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (task: string, pipeline?: PipelineConfig) => void;
  loading: boolean;
  hasHistory: boolean; // Whether this repo has previous runs
  pipeline: PipelineConfig;
  onPipelineChange: (config: PipelineConfig) => void;
  /**
   * Another run uses the user's repository, so a task that would work there cannot start now. The draft can
   * still be written meanwhile; `onOpen` takes the user to the run that is in the way. A task in a checkout
   * of its own is not held up.
   */
  blocked?: { message: string; onOpen?: () => void };
}

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/** Where the task works, shown before it starts so nothing about its folder is a surprise. */
function ExecutionOptions({
  repoName,
  repoPath,
  places,
  isolation,
  onIsolationChange,
  phasing,
  onPhasingChange,
}: Pick<TaskInputProps, 'repoName' | 'repoPath' | 'places' | 'isolation' | 'onIsolationChange' | 'phasing' | 'onPhasingChange'>) {
  const folder = `${stripTrailingSlash(places?.worktreesDir ?? '<where checkouts are kept>')}/${repoName}/<task id>`;
  const radio = 'mt-0.5';
  return (
    <fieldset className="space-y-2 text-sm text-slate-700 dark:text-slate-200" data-testid="execution-options">
      <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Where should it work?</legend>
      <label className="flex items-start gap-2">
        <input type="radio" name="isolation" className={radio} checked={isolation === 'worktree'} onChange={() => onIsolationChange('worktree')} />
        <span>
          <span className="font-medium">Isolated worktree</span> <span className="text-xs text-slate-500">(recommended)</span>
          <span className="block text-xs text-slate-500 dark:text-slate-400">Your folder is not touched and may have changes; other tasks can run at the same time.</span>
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input type="radio" name="isolation" className={radio} checked={isolation === 'in-place'} onChange={() => onIsolationChange('in-place')} />
        <span>
          <span className="font-medium">My repository</span>
          <span className="block text-xs text-slate-500 dark:text-slate-400">It switches the branch there, and needs it to have no uncommitted changes.</span>
        </span>
      </label>
      <p data-testid="isolation-preview" className="text-xs text-slate-500 dark:text-slate-400">
        {isolation === 'worktree' ? (
          <>
            It gets a copy of its own, on its own branch, in <code className="font-mono break-all">{folder}</code>. The exact folder is shown on the run, once it starts.
          </>
        ) : (
          <>
            It works in <code className="font-mono break-all">{repoPath ?? repoName}</code> itself.
          </>
        )}
      </p>
      {isolation === 'worktree' && places?.volatile && (
        <p role="note" data-testid="volatile-folder" className="text-xs text-amber-700 dark:text-amber-300">
          That folder is in the system&apos;s temporary folder: a restart can clear it, and with it any work in a checkout that is not committed. Choose
          another in Settings.
        </p>
      )}
      <label className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-600 dark:text-slate-300">Phases:</span>
        <select
          aria-label="Plan in phases"
          value={phasing}
          onChange={(event) => onPhasingChange(event.target.value as Phasing)}
          className="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
        >
          <option value="auto">Let the architect decide</option>
          <option value="on">Plan in phases</option>
          <option value="off">One pull request</option>
        </select>
        <span className="text-slate-500 dark:text-slate-400">A request too big for one reviewable pull request is split; each phase is merged before the next.</span>
      </label>
    </fieldset>
  );
}

function BlockedNotice({ blocked }: { blocked: NonNullable<TaskInputProps['blocked']> }) {
  return (
    <div
      role="status"
      data-testid="task-blocked"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
    >
      <span>{blocked.message}</span>
      {blocked.onOpen && (
        <button
          type="button"
          onClick={blocked.onOpen}
          className="px-2.5 py-1 rounded-md text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white transition-colors"
        >
          Open it
        </button>
      )}
    </div>
  );
}

export function TaskInput(props: TaskInputProps) {
  const { repoName, value, onChange, onSubmit, loading, hasHistory, pipeline, onPipelineChange, isolation } = props;
  // Only a task that works in the user's own repository waits for whatever else is using it.
  const blocked = isolation === 'in-place' ? props.blocked : undefined;
  const options = <ExecutionOptions {...props} />;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || blocked) return;

    onSubmit(value, pipeline);

    // Clear the draft after submission
    onChange('');
  };

  // Compact view for repos with history (like ChatGPT)
  if (hasHistory) {
    return (
      <form onSubmit={handleSubmit} className="bg-white dark:bg-slate-800 rounded-lg shadow-sm">
        <div className="p-4 space-y-3">
          {blocked && <BlockedNotice blocked={blocked} />}
          <div className="flex gap-3">
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="Describe your next task..."
              disabled={loading}
              rows={2}
              className="flex-1 px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed resize-none"
            />
            <button
              type="submit"
              disabled={loading || !value.trim() || Boolean(blocked)}
              className="px-6 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium rounded-md transition-colors disabled:cursor-not-allowed self-end"
            >
              Run
            </button>
          </div>
          {options}
          <PipelineSelector value={pipeline} onChange={onPipelineChange} />
        </div>
      </form>
    );
  }

  // Full welcome view for first-time (like ChatGPT welcome screen)
  return (
    <form onSubmit={handleSubmit} className="bg-white dark:bg-slate-800 rounded-lg p-6 shadow-sm space-y-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          New Task for {repoName}
        </h3>
      </div>
      {blocked && <BlockedNotice blocked={blocked} />}
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

      {options}

      <PipelineSelector value={pipeline} onChange={onPipelineChange} />

      <button
        type="submit"
        disabled={loading || !value.trim() || Boolean(blocked)}
        className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium rounded-md transition-colors disabled:cursor-not-allowed"
      >
        {loading ? 'Running Factory...' : 'Run Factory'}
      </button>
    </form>
  );
}
