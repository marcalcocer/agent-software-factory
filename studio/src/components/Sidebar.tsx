// Sidebar component for repository navigation

interface Repository {
  name: string;
  path: string;
  recentRuns: number;
}

interface SidebarProps {
  repos: Repository[];
  activeRepo: string | null;
  onSelectRepo: (repo: Repository) => void;
  onBrowseRepo: () => void;
  onOpenSettings: () => void;
  onRemoveRepo?: (repoName: string) => void;
  loading: boolean;
}

export function Sidebar({ repos, activeRepo, onSelectRepo, onBrowseRepo, onOpenSettings, onRemoveRepo, loading }: SidebarProps) {
  return (
    <aside className="w-64 bg-white dark:bg-slate-800 border-r border-slate-200 dark:border-slate-700 flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Repositories</h2>
        <button
          onClick={onBrowseRepo}
          className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          title="Add repository"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      {/* Repo List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-sm text-slate-500">Loading repos...</div>
        ) : repos.length === 0 ? (
          <div className="p-4 text-sm text-slate-500">
            <p className="mb-2">No repositories found</p>
            <p className="text-xs text-slate-400">Click + to add a repository</p>
          </div>
        ) : (
          <nav className="space-y-1 p-2">
            {repos.map((repo) => (
              <div
                key={repo.name}
                className={`group relative rounded-md transition-colors ${
                  activeRepo === repo.name
                    ? 'bg-blue-100 dark:bg-blue-900/40'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-700'
                }`}
              >
                <button
                  onClick={() => onSelectRepo(repo)}
                  className={`w-full text-left px-3 py-2 text-sm font-medium ${
                    activeRepo === repo.name
                      ? 'text-blue-900 dark:text-blue-100'
                      : 'text-slate-700 dark:text-slate-300'
                  }`}
                >
                  <div className="font-medium pr-6">{repo.name}</div>
                  <div className="text-xs text-slate-500">
                    {repo.recentRuns} runs
                  </div>
                </button>
                {onRemoveRepo && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveRepo(repo.name);
                    }}
                    title="Remove repository"
                    className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-all"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </nav>
        )}
      </div>

      {/* Settings */}
      <div className="border-t border-slate-200 dark:border-slate-700 p-4">
        <button
          onClick={onOpenSettings}
          className="w-full px-3 py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 transition-colors text-left"
        >
          ⚙️ Settings
        </button>
      </div>
    </aside>
  );
}
