import { useState } from 'react';

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
  onAddRepo: (path: string) => void;
  onOpenSettings: () => void;
  loading: boolean;
}

export function Sidebar({ repos, activeRepo, onSelectRepo, onAddRepo, onOpenSettings, loading }: SidebarProps) {
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [newRepoPath, setNewRepoPath] = useState('');

  const handleAddRepo = () => {
    if (newRepoPath.trim()) {
      onAddRepo(newRepoPath.trim());
      setNewRepoPath('');
      setShowAddRepo(false);
    }
  };

  return (
    <aside className="w-64 bg-white dark:bg-slate-800 border-r border-slate-200 dark:border-slate-700 flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Repositories</h2>
        <button
          onClick={() => setShowAddRepo(!showAddRepo)}
          className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 text-lg font-bold"
          title="Add repository"
        >
          +
        </button>
      </div>

      {/* Add Repo Form */}
      {showAddRepo && (
        <div className="p-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
          <input
            type="text"
            value={newRepoPath}
            onChange={(e) => setNewRepoPath(e.target.value)}
            placeholder="Repository name or path..."
            className="w-full px-2 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400"
            onKeyDown={(e) => e.key === 'Enter' && handleAddRepo()}
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleAddRepo}
              className="flex-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded"
            >
              Add
            </button>
            <button
              onClick={() => setShowAddRepo(false)}
              className="flex-1 px-2 py-1 text-xs bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

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
              <button
                key={repo.name}
                onClick={() => onSelectRepo(repo)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  activeRepo === repo.name
                    ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-100'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                }`}
              >
                <div className="font-medium">{repo.name}</div>
                <div className="text-xs text-slate-500">
                  {repo.recentRuns} runs
                </div>
              </button>
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
