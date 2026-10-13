interface RepoTabsProps {
  tabs: string[];
  activeTab: string;
  onSelectTab: (repoName: string) => void;
  onCloseTab: (repoName: string) => void;
  disabled?: boolean;
}

export function RepoTabs({ tabs, activeTab, onSelectTab, onCloseTab, disabled = false }: RepoTabsProps) {
  if (tabs.length === 0) {
    return (
      <div className="border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-3 text-slate-500 dark:text-slate-400">
        No repositories opened. Select one from the sidebar.
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 overflow-x-auto">
      {tabs.map((tab) => (
        <div
          key={tab}
          className={`flex items-center gap-2 px-3 py-3 border-b-2 transition-colors whitespace-nowrap ${
            disabled 
              ? 'cursor-not-allowed opacity-50'
              : 'cursor-pointer'
          } ${
            activeTab === tab
              ? 'border-blue-600 dark:border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
          onClick={() => !disabled && onSelectTab(tab)}
        >
          <span className="font-medium">{tab}</span>
          {!disabled && (
            <button
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
      ))}
    </div>
  );
}
