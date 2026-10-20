interface RepoTabsProps {
  tabs: string[];
  activeTab: string;
  onSelectTab: (repoName: string) => void;
  onCloseTab: (repoName: string) => void;
  runningRepo?: string | null;
}

export function RepoTabs({ tabs, activeTab, onSelectTab, onCloseTab, runningRepo = null }: RepoTabsProps) {
  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 overflow-x-auto">
      {tabs.map((tab) => {
        const isRunning = runningRepo === tab;
        return (
          <div
            key={tab}
            className={`flex items-center gap-2 px-3 py-3 border-b-2 cursor-pointer transition-colors whitespace-nowrap ${
              activeTab === tab
                ? 'border-blue-600 dark:border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
            onClick={() => onSelectTab(tab)}
          >
            <span className="font-medium">{tab}</span>
            {isRunning && (
              <span className="text-xs text-blue-500 animate-pulse" title="Factory running">
                ●
              </span>
            )}
            {!isRunning && (
              <button
                aria-label={`Close ${tab}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab);
                }}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
