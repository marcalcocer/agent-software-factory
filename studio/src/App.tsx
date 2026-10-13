import { useEffect, useState } from 'react';
import type { AuthProvider } from '@shared/types';
import { Sidebar } from './components/Sidebar';
import { RepoTabs } from './components/RepoTabs';
import { TaskInput } from './components/TaskInput';
import { RunHistory } from './components/RunHistory';
import { LiveOutput } from './components/LiveOutput';
import { RunDetails } from './components/RunDetails';
import { SettingsPanel } from './components/SettingsPanel';

interface Repository {
  name: string;
  path: string;
  recentRuns: number;
}

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
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

    // Subscribe to factory events
    const unsubscribeCompleted = window.api.on('factory:completed', (runId: string, exitCode: number) => {
      console.log(`Run ${runId} completed with exit code ${exitCode}`);
      setRuns((prev) =>
        prev.map((run) =>
          run.id === runId
            ? { ...run, status: exitCode === 0 ? 'completed' : 'failed', endTime: new Date() }
            : run
        )
      );
      if (activeRunId === runId) {
        setActiveRunId(null);
      }
    });

    const unsubscribeError = window.api.on('factory:error', (runId: string, error: string) => {
      console.error(`Run ${runId} error:`, error);
      setRuns((prev) =>
        prev.map((run) =>
          run.id === runId
            ? { ...run, status: 'failed', endTime: new Date() }
            : run
        )
      );
    });

    return () => {
      unsubscribeCompleted();
      unsubscribeError();
    };
  }, [activeRunId]);

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

  const handleSelectRepo = (repo: Repository) => {
    // Add to open tabs if not already open
    if (!openTabs.includes(repo.name)) {
      setOpenTabs([...openTabs, repo.name]);
    }
    setActiveTab(repo.name);
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

  const handleRunTask = async (task: string) => {
    if (!activeTab) return;

    setRunLoading(true);
    setError(null);

    try {
      // Load settings to get maxAttempts and dryRun
      const settings = await window.api.invoke('settings:get');
      
      const result = await window.api.invoke('factory:run-task', {
        repo: activeTab,
        task,
        maxAttempts: settings.global.defaultMaxAttempts,
        dryRun: settings.global.dryRunByDefault,
      });

      // Add to run history
      const newRun: Run = {
        id: result.runId,
        task,
        status: 'running',
        startTime: new Date(),
      };

      setRuns([newRun, ...runs]);
      setActiveRunId(result.runId); // Track active run for live output
    } catch (err) {
      console.error('Failed to run task:', err);
      setError(`Task execution failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunLoading(false);
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

                {/* Task Input */}
                <TaskInput
                  repoName={activeTab}
                  onSubmit={handleRunTask}
                  loading={runLoading}
                />

                {/* Live Output */}
                {activeRunId && (
                  <LiveOutput runId={activeRunId} isRunning={true} />
                )}

                {/* Run History */}
                <RunHistory
                  runs={runs}
                  loading={false}
                  onSelectRun={(runId) => setSelectedRunId(runId)}
                />
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
        <RunDetails runId={selectedRunId} onClose={() => setSelectedRunId(null)} />
      )}

      <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

export default App;
