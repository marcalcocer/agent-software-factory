import { useEffect, useMemo, useRef, useState } from 'react';
import type { AuthProvider, PipelineConfig, PrMergeNotice, PrMergeResult, PrWatchState } from '@shared/types';
import { Sidebar } from './components/Sidebar';
import { RepoTabs } from './components/RepoTabs';
import { TaskInput } from './components/TaskInput';
import { RunHistory } from './components/RunHistory';
import { RunDetails } from './components/RunDetails';
import { SettingsPanel } from './components/SettingsPanel';
import { PipelineView } from './components/PipelineView';
import { ConfirmModal } from './components/ConfirmModal';
import { PullRequestsPanel } from './components/PullRequestsPanel';
import { applyTheme, watchSystemTheme, type ThemeSetting } from './theme';

interface Repository {
  name: string;
  path: string;
  recentRuns: number;
}

interface Run {
  id: string;
  title: string;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'escalated';
  startTime: Date;
  endTime?: Date;
  error?: string;
  /** Which task this run belongs to, and which round of it (a round continues an earlier run). */
  rootRunId?: string;
  round?: number;
  pullRequestNumber?: number;
  summary?: {
    durationMs: number;
    tokensUsed: number;
    stepsCompleted: number;
  };
}

function App() {
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);

  // Phase 2 state
  const [repos, setRepos] = useState<Repository[]>([]);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runLoading, setRunLoading] = useState(false);
  const [reposLoading, setReposLoading] = useState(false);

  // Phase 3 state - real-time and modals
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runningRepo, setRunningRepo] = useState<string | null>(null); // Track which repo is running
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [viewingHistoryRunId, setViewingHistoryRunId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [taskDrafts, setTaskDrafts] = useState<Record<string, string>>({});
  const [theme, setTheme] = useState<ThemeSetting>('system');
  const [deleteConfirmRunId, setDeleteConfirmRunId] = useState<string | null>(null);
  const [removeConfirmRepoName, setRemoveConfirmRepoName] = useState<string | null>(null);
  
  // Pipeline configuration state (per-task)
  const [pipelineConfig, setPipelineConfig] = useState<PipelineConfig>({
    qa: true,
    review: true,
    security: true,
    documentation: true,
  });
  
  // Pull-request watcher: the main process looks for review comments in the background and pushes
  // its view of every open pull request here.
  const [prWatch, setPrWatch] = useState<PrWatchState | null>(null);
  /** Merges just done (or rehearsed): a merged pull request leaves the list, so its outcome is kept here. */
  const [mergeNotices, setMergeNotices] = useState<PrMergeNotice[]>([]);

  // The factory event handlers below are registered in an effect, so they close over the state of
  // the render that registered them. They read it from here instead - otherwise a run that
  // finished while the user was looking at another repository acted on the wrong tab (and passed
  // the tab *name* where a repository *path* is required).
  const latest = useRef({ activeTab, runningRepo, repos, activeRunId });
  latest.current = { activeTab, runningRepo, repos, activeRunId };

  // Apply the theme to the document root and follow OS changes while in "system" mode.
  useEffect(() => {
    applyTheme(theme);
    return watchSystemTheme(() => applyTheme(theme));
  }, [theme]);

  // Load runs when active tab changes (or the repository list arrives)
  useEffect(() => {
    if (activeTab) {
      const repo = repos.find(r => r.name === activeTab);
      if (repo) {
        loadRunsForRepo(repo.path);
      }
    }
  }, [activeTab, repos]);

  // Clear any open pipeline view when switching tab. This must depend on the tab ONLY: it used to
  // share the effect above, so every reload of the repository list (a new array) closed the run
  // the user was looking at - e.g. the one they were deliberately kept on after it finished.
  useEffect(() => {
    if (activeTab) setViewingHistoryRunId(null);
  }, [activeTab]);

  // Follow the pull-request watcher. It lives in the main process (so it keeps checking whichever
  // repository is on screen); this just mirrors its latest view.
  useEffect(() => {
    if (!window.api) return;
    let cancelled = false;
    window.api
      .invoke('pr-watch:get')
      .then((state) => {
        if (!cancelled) setPrWatch(state);
      })
      .catch(() => {});
    const off = window.api.on('pr-watch:changed', (state: PrWatchState) => setPrWatch(state));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  useEffect(() => {
    // Test if window.api exists
    if (!window.api) {
      setError('window.api is not available - preload script issue');
      setLoading(false);
      return;
    }

    // Test IPC communication
    window.api.invoke('auth:status')
      .then(setProviders)
      .catch((err) => {
        console.error('Auth status error:', err);
        setError(`Failed to load auth status: ${err.message || err}`);
      })
      .finally(() => setLoading(false));

    // Load repositories list
    loadRepositories();

    // Restore the saved theme
    window.api.invoke('settings:get')
      .then((settings) => setTheme(settings.global.theme))
      .catch(() => {});

    // Subscribe to factory events
    // Refresh the history of the repository the user is looking at (not of the one that ran:
    // the list state is shared, so loading another repository's runs would blank this one).
    const reloadVisibleRuns = () => {
      const { activeTab: tab, repos: allRepos } = latest.current;
      const repo = allRepos.find((r) => r.name === tab);
      if (repo) loadRunsForRepo(repo.path);
      // Keep the sidebar's per-repository run counts current as well.
      loadRepositories();
    };

    const unsubscribeCompleted = window.api.on('factory:completed', (runId: string, exitCode: number) => {
      console.log(`Run ${runId} completed with exit code ${exitCode}`);

      // Exit code 3 means SUSPENDED (waiting for human input).
      // Keep the pipeline visible: it picks up the pending input and shows the form.
      if (exitCode === 3) {
        setRuns((prev) =>
          prev.map((run) => (run.id === runId ? { ...run, status: 'escalated' } : run)),
        );
        reloadVisibleRuns();
        return;
      }

      setRuns((prev) =>
        prev.map((run) =>
          run.id === runId
            ? { ...run, status: exitCode === 0 ? 'completed' : 'failed', endTime: new Date() }
            : run
        )
      );

      if (latest.current.activeRunId === runId) {
        // Stay on the finished run instead of bouncing back to the task form: that is where the
        // user reads the outcome - or the reason it failed. The view now reads it from disk.
        if (latest.current.activeTab === latest.current.runningRepo) {
          setViewingHistoryRunId(runId);
        }
        setActiveRunId(null);
        setRunLoading(false);
        setRunningRepo(null);
      }
      reloadVisibleRuns();
    });

    const unsubscribeError = window.api.on('factory:error', (runId: string, message: string) => {
      console.error(`Run ${runId} error:`, message);
      setRuns((prev) =>
        prev.map((run) =>
          run.id === runId ? { ...run, status: 'failed', endTime: new Date() } : run
        )
      );
      if (latest.current.activeRunId === runId) {
        // The process could not even start, so there is no run on disk to show: say why.
        setError(`The factory could not be started: ${message}`);
        setActiveRunId(null);
        setRunLoading(false);
        setRunningRepo(null);
      }
    });

    return () => {
      unsubscribeCompleted();
      unsubscribeError();
    };
  }, []);

  const loadRepositories = async () => {
    setReposLoading(true);
    try {
      const repoList = await window.api.invoke('factory:list-repos');
      setRepos(repoList);
    } catch (err) {
      console.error('Failed to load repos:', err);
    } finally {
      setReposLoading(false);
    }
  };

  const loadRunsForRepo = async (repoPath: string) => {
    try {
      const factoryRuns = await window.api.invoke('factory:list', repoPath);
      
      // Transform FactoryRun[] to Run[] and merge with existing runs
      const newRuns: Run[] = factoryRuns.map((fr: any) => ({
        id: fr.runId,
        title: 'Untitled run', // Will be overridden by local state if exists
        task: fr.task,
        status: fr.status === 'RUNNING' ? 'running' :
                fr.status === 'FAILED' ? 'failed' :
                fr.status === 'ESCALATED_TO_HUMAN' ? 'escalated' :
                fr.status === 'SUSPENDED' ? 'escalated' :  // Suspended runs need user action
                'completed',
        startTime: new Date(fr.startedAt),
        endTime: fr.finishedAt ? new Date(fr.finishedAt) : undefined,
        error: fr.error,
        rootRunId: fr.rootRunId,
        round: fr.round,
        pullRequestNumber: fr.pullRequest?.number,
        summary: fr.tokens ? {
          durationMs: fr.finishedAt ? 
            new Date(fr.finishedAt).getTime() - new Date(fr.startedAt).getTime() : 0,
          tokensUsed: fr.tokens.total,
          stepsCompleted: fr.steps?.length || 0,
        } : undefined,
      }));

      // Merge with existing runs, keeping titles from current state
      setRuns((prev) => {
        const existing = new Map(prev.map(r => [r.id, r]));
        return newRuns.map(nr => existing.get(nr.id) ? { ...nr, title: existing.get(nr.id)!.title } : nr);
      });
    } catch (err) {
      console.error('Failed to load runs for repo:', err);
    }
  };

  const handleSelectRepo = (repo: Repository) => {
    // Add to open tabs if not already open
    if (!openTabs.includes(repo.name)) {
      setOpenTabs([...openTabs, repo.name]);
    }
    setActiveTab(repo.name);
    
    // Load runs for this repo
    loadRunsForRepo(repo.path);
  };

  const handleBrowseRepo = async () => {
    try {
      const repo = await window.api.invoke('repo:browse');
      
      if (repo) {
        // Convert to our Repository format
        const newRepo: Repository = {
          name: repo.name,
          path: repo.path,
          recentRuns: 0,
        };

        // Add to repos list if not already there
        if (!repos.some((r) => r.name === newRepo.name)) {
          setRepos([...repos, newRepo]);
        }

        // Open it
        handleSelectRepo(newRepo);
      }
    } catch (error) {
      console.error('Failed to browse for repository:', error);
      setError(`Failed to add repository: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleCloseTab = (repoName: string) => {
    setOpenTabs(openTabs.filter((name) => name !== repoName));
    if (activeTab === repoName) {
      setActiveTab(openTabs.length > 1 ? openTabs[0] : null);
    }
  };

  const handleRunTask = async (task: string, pipeline?: PipelineConfig) => {
    if (!activeTab) return;

    setRunLoading(true);
    setRunningRepo(activeTab); // Track which repo is running
    setError(null);

    try {
      // Load settings to get maxAttempts and dryRun
      const settings = await window.api.invoke('settings:get');
      
      const result = await window.api.invoke('factory:run-task', {
        repo: activeTab,
        task,
        maxAttempts: settings.global.defaultMaxAttempts,
        dryRun: settings.global.dryRunByDefault,
        pipeline: pipeline || pipelineConfig,
      });

      // Add to run history
      const newRun: Run = {
        id: result.runId,
        title: 'Untitled run',
        task,
        status: 'running',
        startTime: new Date(),
      };

      setRuns([newRun, ...runs]);
      setActiveRunId(result.runId); // Track active run for live output
      
      // Clear task draft after successful submission
      setTaskDrafts({ ...taskDrafts, [activeTab]: '' });
    } catch (err) {
      console.error('Failed to run task:', err);
      setError(`Task execution failed: ${err instanceof Error ? err.message : String(err)}`);
      setRunLoading(false); // Only stop loading on error during submission
    }
  };

  const handleRenameRun = (runId: string, title: string) => {
    setRuns((prev) => prev.map((run) => (run.id === runId ? { ...run, title } : run)));
  };

  const handleDeleteRun = async () => {
    if (!deleteConfirmRunId) return;

    try {
      await window.api.invoke('factory:delete', deleteConfirmRunId);
      
      // Remove from UI state
      setRuns((prev) => prev.filter((run) => run.id !== deleteConfirmRunId));
      
      // Close any open views for this run
      if (selectedRunId === deleteConfirmRunId) setSelectedRunId(null);
      if (viewingHistoryRunId === deleteConfirmRunId) setViewingHistoryRunId(null);
      
      setDeleteConfirmRunId(null);
    } catch (err) {
      console.error('Failed to delete run:', err);
      setError(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
      setDeleteConfirmRunId(null);
    }
  };

  /**
   * Starts a round on a pull request. The user asked for it, so - like a task they typed
   * themselves - it opens on screen straight away.
   */
  const handlePrRevise = async (
    key: string,
    options?: { task?: string; action?: 'RERUN_IMPLEMENTATION' | 'RERUN_PLANNING' },
  ) => {
    const { runId } = await window.api.invoke('pr-watch:revise', key, options);
    setError(null);
    setViewingHistoryRunId(null);
    setRunningRepo(activeTab);
    setActiveRunId(runId);
    setRunLoading(true);
    const repo = repos.find((r) => r.name === activeTab);
    if (repo) loadRunsForRepo(repo.path);
  };

  /**
   * Squash-merges an approved pull request. The pull request disappears from the list the moment it
   * is merged, so what happened (and what deliberately did not: a working copy left where it was, a
   * branch that was kept) is remembered as a notice the user can read and dismiss.
   */
  const handlePrMerge = async (
    key: string,
    input: { subject: string; body: string; deleteBranch: boolean },
  ): Promise<PrMergeResult> => {
    const pr = prWatch?.pullRequests.find((candidate) => candidate.key === key);
    const result = await window.api.invoke('pr-watch:merge', key, input);
    if (pr) {
      const notice: PrMergeNotice = {
        id: `${key}@${Date.now()}`,
        repoPath: pr.repoPath,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        at: new Date().toISOString(),
        result,
      };
      setMergeNotices((previous) => [notice, ...previous].slice(0, 5));
    }
    return result;
  };

  /** Opens a run (a round of a pull request, say) in the pipeline view. */
  const handleOpenRun = (runId: string) => {
    setViewingHistoryRunId(runId);
  };

  /** Review comments waiting per repository, for the sidebar. */
  const prBadges = useMemo(() => {
    const badges: Record<string, number> = {};
    for (const pr of prWatch?.pullRequests ?? []) {
      if (pr.pending.length === 0 && pr.status !== 'awaiting-approval') continue;
      badges[pr.repoName] = (badges[pr.repoName] ?? 0) + Math.max(1, pr.pending.length);
    }
    return badges;
  }, [prWatch]);

  const handleRemoveRepo = async () => {
    if (!removeConfirmRepoName) return;

    try {
      await window.api.invoke('factory:remove-repo', removeConfirmRepoName);
      
      // Remove from UI state
      setRepos((prev) => prev.filter((r) => r.name !== removeConfirmRepoName));
      
      // Close tab if it's open
      setOpenTabs((prev) => prev.filter((tab) => tab !== removeConfirmRepoName));
      
      // Switch to first available tab if active tab was removed
      if (activeTab === removeConfirmRepoName) {
        const remaining = openTabs.filter((tab) => tab !== removeConfirmRepoName);
        setActiveTab(remaining.length > 0 ? remaining[0] : null);
      }
      
      setRemoveConfirmRepoName(null);
    } catch (err) {
      console.error('Failed to remove repo:', err);
      setError(`Remove failed: ${err instanceof Error ? err.message : String(err)}`);
      setRemoveConfirmRepoName(null);
    }
  };

  const handleResumeRun = async (runId: string) => {
    setSelectedRunId(null);
    setRunningRepo(activeTab);
    setActiveRunId(runId);
    setRunLoading(true);
    setError(null);
    setRuns((prev) =>
      prev.map((run) =>
        run.id === runId ? { ...run, status: 'running', endTime: undefined } : run
      )
    );

    try {
      await window.api.invoke('factory:resume', { runId });
    } catch (err) {
      console.error('Failed to resume run:', err);
      setError(`Resume failed: ${err instanceof Error ? err.message : String(err)}`);
      setRunLoading(false);
      setRunningRepo(null);
      setActiveRunId(null);
    }
  };

  const handleLogin = async () => {
    setLoginLoading(true);
    setError(null);
    try {
      console.log('Checking Claude Code auth status...');
      
      // Just check current status - no polling!
      const updated = await window.api.invoke('auth:status');
      setProviders(updated);
      
      const isAuth = updated.some((p) => p.status === 'authenticated');
      
      if (isAuth) {
        console.log('Authenticated!');
        setError(null);
      } else {
        setError('Not authenticated yet. Please complete the login in your terminal, then click "Check Auth Status" again.');
      }
    } catch (error) {
      console.error('Login check failed:', error);
      setError(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoginLoading(false);
    }
  };

  // Show auth screen if not logged in
  const isAuthenticated = providers.some((p) => p.status === 'authenticated');

  // Show loading screen while checking auth
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
          <p className="text-slate-600 dark:text-slate-400">Checking authentication...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100">
        {/* Header */}
        <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
          <div className="px-6 py-4 flex items-center justify-between">
            <h1 className="text-xl font-semibold">AI Factory Studio</h1>
            <div className="text-sm text-slate-500">v0.1.0</div>
          </div>
        </header>

        {/* Auth Screen */}
        <main className="p-8">
          <div className="max-w-md mx-auto mt-20 space-y-6">
            {error && (
              <div className="bg-red-100 dark:bg-red-900 p-4 rounded">
                <p className="text-red-800 dark:text-red-200 text-sm">{error}</p>
              </div>
            )}

            <section className="bg-white dark:bg-slate-800 rounded-lg p-6 shadow-sm">
              <h2 className="text-2xl font-bold mb-4">Welcome Back</h2>
              <p className="text-slate-600 dark:text-slate-300 mb-4">
                Authenticate with Claude CLI to get started with the software factory.
              </p>

              {/* Instructions */}
              <div className="bg-slate-100 dark:bg-slate-900 rounded-lg p-4 mb-6">
                <h3 className="font-medium text-slate-900 dark:text-slate-100 mb-2">
                  Login Instructions:
                </h3>
                <ol className="text-sm text-slate-600 dark:text-slate-400 space-y-2 list-decimal list-inside">
                  <li>Open a terminal window</li>
                  <li>Run: <code className="bg-slate-200 dark:bg-slate-800 px-2 py-0.5 rounded font-mono">claude login</code></li>
                  <li>Type <code className="bg-slate-200 dark:bg-slate-800 px-2 py-0.5 rounded font-mono">/login</code> and press Enter</li>
                  <li>Select the first option (OAuth login)</li>
                  <li>Complete login in your browser</li>
                  <li>Click "Check Auth Status" below</li>
                </ol>
              </div>

              <div className="space-y-3">
                <button
                  onClick={handleLogin}
                  disabled={loginLoading}
                  className={`w-full px-4 py-3 rounded-md font-medium transition-colors ${
                    loginLoading
                      ? 'bg-blue-400 text-white cursor-not-allowed'
                      : 'bg-blue-600 hover:bg-blue-700 text-white cursor-pointer'
                  }`}
                >
                  {loginLoading ? 'Checking...' : 'Check Auth Status'}
                </button>

                {loginLoading && (
                  <p className="text-center text-sm text-slate-500">
                    Waiting for authentication... Complete the login in your terminal.
                  </p>
                )}
              </div>
            </section>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
        <div className="px-6 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold">AI Factory Studio</h1>
          <div className="text-sm text-slate-500">v0.1.0</div>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <Sidebar
          repos={repos}
          activeRepo={activeTab}
          onSelectRepo={handleSelectRepo}
          onBrowseRepo={handleBrowseRepo}
          onOpenSettings={() => setSettingsOpen(true)}
          onRemoveRepo={(repoName) => setRemoveConfirmRepoName(repoName)}
          badges={prBadges}
          loading={reposLoading}
        />

        {/* Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Tabs */}
          <RepoTabs
            tabs={openTabs}
            activeTab={activeTab || ''}
            onSelectTab={setActiveTab}
            onCloseTab={handleCloseTab}
            runningRepo={runningRepo}
          />

          {/* Main Panel */}
          <main className="flex-1 overflow-y-auto">
            {activeTab ? (
              <div className="p-6 space-y-6 max-w-4xl">
                {/* Error */}
                {error && (
                  <div className="bg-red-100 dark:bg-red-900 p-4 rounded">
                    <p className="text-red-800 dark:text-red-200 text-sm">{error}</p>
                  </div>
                )}

                {/* Task Input or Pipeline View */}
                {runLoading && activeTab === runningRepo ? (
                  <PipelineView
                    key={activeRunId ?? 'starting'}
                    runId={activeRunId}
                    isRunning={runLoading}
                    pipelineConfig={pipelineConfig}
                    onRetry={handleResumeRun}
                  />
                ) : viewingHistoryRunId ? (
                  <PipelineView
                    key={viewingHistoryRunId}
                    runId={viewingHistoryRunId}
                    isRunning={false}
                    onClose={() => setViewingHistoryRunId(null)}
                    onRetry={handleResumeRun}
                    onOpenRun={handleOpenRun}
                  />
                ) : (
                  <>
                    {/* Run History - shown above the task input when there's history */}
                    {(() => {
                      const repoRuns = runs.filter(run => run.id.includes(activeTab));
                      if (repoRuns.length === 0) return null;

                      return (
                        <RunHistory
                          runs={repoRuns}
                          loading={false}
                          onSelectRun={(runId) => setViewingHistoryRunId(runId)}
                          onResume={handleResumeRun}
                          onRename={handleRenameRun}
                          onDelete={(runId) => setDeleteConfirmRunId(runId)}
                        />
                      );
                    })()}

                    <div className="space-y-4">
                      <PullRequestsPanel
                        repoPath={repos.find((r) => r.name === activeTab)?.path ?? ''}
                        state={prWatch}
                        onRefresh={() => {
                          window.api.invoke('pr-watch:refresh').catch(() => {});
                        }}
                        onTriage={(key) => window.api.invoke('pr-watch:triage', key)}
                        onRevise={handlePrRevise}
                        onDismiss={(key) => window.api.invoke('pr-watch:dismiss', key)}
                        onPostReplies={(key) => window.api.invoke('pr-watch:post-replies', key)}
                        onOpenRun={handleOpenRun}
                        onApprove={(key, headSha) => window.api.invoke('pr-watch:approve', key, headSha)}
                        onWithdrawApproval={(key) => window.api.invoke('pr-watch:withdraw-approval', key)}
                        onMergeDraft={(key) => window.api.invoke('pr-watch:merge-draft', key)}
                        onMerge={handlePrMerge}
                        notices={mergeNotices}
                        onDismissNotice={(id) => setMergeNotices((previous) => previous.filter((notice) => notice.id !== id))}
                      />

                      <TaskInput
                        repoName={activeTab}
                        value={taskDrafts[activeTab] || ''}
                        onChange={(value) => setTaskDrafts({ ...taskDrafts, [activeTab]: value })}
                        onSubmit={handleRunTask}
                        loading={false}
                        hasHistory={runs.some(run => run.id.includes(activeTab))}
                        pipeline={pipelineConfig}
                        onPipelineChange={setPipelineConfig}
                      />
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-slate-500">
                <div className="text-center">
                  <p className="text-lg mb-2">No repository selected</p>
                  <p className="text-sm">Choose a repository from the sidebar to get started</p>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>

      {/* Modals */}
      {selectedRunId && (
        <RunDetails
          runId={selectedRunId}
          onClose={() => setSelectedRunId(null)}
          onResume={handleResumeRun}
        />
      )}

      <SettingsPanel
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onThemeChange={setTheme}
      />

      <ConfirmModal
        isOpen={deleteConfirmRunId !== null}
        title="Delete Run"
        message={`Are you sure you want to delete this run? This will permanently delete all logs, artifacts, and history. This action cannot be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        onConfirm={handleDeleteRun}
        onCancel={() => setDeleteConfirmRunId(null)}
      />

      <ConfirmModal
        isOpen={removeConfirmRepoName !== null}
        title="Remove Repository"
        message={`Remove "${removeConfirmRepoName}" from the sidebar? This won't delete any files or runs, just removes it from your saved repositories list.`}
        confirmText="Remove"
        cancelText="Cancel"
        variant="warning"
        onConfirm={handleRemoveRepo}
        onCancel={() => setRemoveConfirmRepoName(null)}
      />
    </div>
  );
}

export default App;
