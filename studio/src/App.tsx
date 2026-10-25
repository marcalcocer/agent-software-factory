import { useEffect, useMemo, useRef, useState } from 'react';
import type { AuthProvider, FactoryRun, PipelineConfig, Places, PrMergeNotice, PrMergeResult, PrWatchState, Project, ProjectPhase } from '@shared/types';
import { Sidebar } from './components/Sidebar';
import { RepoTabs } from './components/RepoTabs';
import { TaskInput, type Isolation, type Phasing } from './components/TaskInput';
import { RoadmapPanel } from './components/RoadmapPanel';
import { RunHistory } from './components/RunHistory';
import { RunDetails } from './components/RunDetails';
import { SettingsPanel } from './components/SettingsPanel';
import { PipelineView } from './components/PipelineView';
import { ConfirmModal } from './components/ConfirmModal';
import { PullRequestsPanel } from './components/PullRequestsPanel';
import { errorText } from './lib/errorText';
import { titleFromTask } from './lib/runTitle';
import { applyTheme, watchSystemTheme, type ThemeSetting } from './theme';

interface Repository {
  name: string;
  path: string;
  recentRuns: number;
}

interface Run {
  id: string;
  /** The folder name of the repository the run belongs to. */
  repoName: string;
  /** What the run is called: named by the factory, renamed by the user, or - for old runs - its first sentence. */
  title: string;
  titleSource?: FactoryRun['titleSource'];
  taskId?: string;
  task: string;
  /** `waiting`: parked at a gate (a question, an approval) until the user answers. */
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'escalated';
  startTime: Date;
  endTime?: Date;
  error?: string;
  /** Which task this run belongs to, and which round of it (a round continues an earlier run). */
  rootRunId?: string;
  round?: number;
  pullRequestNumber?: number;
  /** Where the work happens. A run from before checkouts existed worked in the repository. */
  isolation?: 'worktree' | 'in-place';
  /** The phase of a project this run implements. */
  phaseId?: string;
  /** Stopped on Claude's usage limit: the Studio's plan to retry it when the limit is back. */
  autoRetry?: FactoryRun['autoRetry'];
  summary?: {
    durationMs: number;
    tokensUsed: number;
    stepsCompleted: number;
  };
}

/** "Phase 2 of 4 · Redesign the frontend" - for a run that implements a phase. */
function phaseLabelOf(projects: Project[], phaseId: string | undefined): string | undefined {
  if (!phaseId) return undefined;
  for (const project of projects) {
    const phase = project.phases.find((candidate) => candidate.id === phaseId);
    if (phase) return `Phase ${phase.ordinal} of ${project.phases.filter((other) => other.status !== 'SKIPPED' || other.id === phase.id).length} · ${project.title}`;
  }
  return undefined;
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
  // The runs of each repository, by its path: a repository's list is only ever replaced by its own load.
  const [runsByRepo, setRunsByRepo] = useState<Record<string, Run[]>>({});
  const [runLoading, setRunLoading] = useState(false);
  const [reposLoading, setReposLoading] = useState(false);

  // Phase 3 state - real-time and modals
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runningRepo, setRunningRepo] = useState<string | null>(null); // Track which repo is running
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // The run on screen. Not the same thing as the run that is alive: the user can leave a run that is
  // going (Back), and open one that has finished.
  const [openRunId, setOpenRunId] = useState<string | null>(null);
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
    polish: true,
  });
  
  // Pull-request watcher: the main process looks for review comments in the background and pushes
  // its view of every open pull request here.
  const [prWatch, setPrWatch] = useState<PrWatchState | null>(null);

  // Where a new task works, and whether the architect may split it into phases. Both start from Settings.
  const [isolation, setIsolation] = useState<Isolation>('worktree');
  const [phasing, setPhasing] = useState<Phasing>('auto');
  // Where the factory makes checkouts, as the factory says it - for the preview of a task's folder.
  const [places, setPlaces] = useState<Places | null>(null);
  const loadPlaces = () => {
    window.api.invoke('places:get').then(setPlaces).catch(() => {});
  };
  // The projects (big requests split into phases) of each repository, read through the factory.
  const [projectsByRepo, setProjectsByRepo] = useState<Record<string, Project[]>>({});
  const [projectsError, setProjectsError] = useState<string | null>(null);
  /** Merges just done (or rehearsed): a merged pull request leaves the list, so its outcome is kept here. */
  const [mergeNotices, setMergeNotices] = useState<PrMergeNotice[]>([]);

  // The factory event handlers below are registered in an effect, so they close over the state of
  // the render that registered them. They read it from here instead - otherwise a run that
  // finished while the user was looking at another repository acted on the wrong tab (and passed
  // the tab *name* where a repository *path* is required).
  const latest = useRef({ activeTab, runningRepo, repos, activeRunId });
  latest.current = { activeTab, runningRepo, repos, activeRunId };

  /** Changes one run wherever it is listed (it is in exactly one repository's list). */
  const updateRun = (runId: string, change: Partial<Run>) =>
    setRunsByRepo((previous) => {
      const next: Record<string, Run[]> = {};
      for (const [path, list] of Object.entries(previous)) {
        next[path] = list.map((run) => (run.id === runId ? { ...run, ...change } : run));
      }
      return next;
    });

  const activeRepoPath = repos.find((repo) => repo.name === activeTab)?.path ?? null;
  const projects = (activeRepoPath && projectsByRepo[activeRepoPath]) || [];
  const repoRuns = ((activeRepoPath && runsByRepo[activeRepoPath]) || []).map((run) => {
    const phaseLabel = phaseLabelOf(projects, run.phaseId);
    return phaseLabel ? { ...run, phaseLabel } : run;
  });
  /**
   * A run that is using the user's own repository: a task that would work there cannot start until it is
   * done. A run in a checkout of its own uses nothing but that checkout, so it is not in the way.
   */
  const busyRun = repoRuns.find((run) => (run.status === 'running' || run.status === 'waiting') && run.isolation !== 'worktree');

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
        loadProjects(repo.path);
      }
    }
  }, [activeTab, repos]);

  // Clear any open pipeline view when switching tab. This must depend on the tab ONLY: it used to
  // share the effect above, so every reload of the repository list (a new array) closed the run
  // the user was looking at - e.g. the one they were deliberately kept on after it finished.
  useEffect(() => {
    if (activeTab) setOpenRunId(null);
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
      .then((settings) => {
        setTheme(settings.global.theme);
        setIsolation(settings.global.isolation ?? 'worktree');
      })
      .catch(() => {});
    loadPlaces();

    // Subscribe to factory events
    // Refresh the history of the repository the user is looking at (not of the one that ran:
    // the list state is shared, so loading another repository's runs would blank this one).
    const reloadVisibleRuns = () => {
      const { activeTab: tab, repos: allRepos } = latest.current;
      const repo = allRepos.find((r) => r.name === tab);
      if (repo) {
        loadRunsForRepo(repo.path);
        // A run on a phase changes where the project stands.
        loadProjects(repo.path);
      }
      // Keep the sidebar's per-repository run counts current as well.
      loadRepositories();
    };

    const unsubscribeCompleted = window.api.on('factory:completed', (runId: string, exitCode: number) => {
      console.log(`Run ${runId} completed with exit code ${exitCode}`);

      // Exit code 3 means SUSPENDED (waiting for human input).
      // Keep the pipeline visible: it picks up the pending input and shows the form.
      if (exitCode === 3) {
        updateRun(runId, { status: 'waiting' });
        reloadVisibleRuns();
        return;
      }

      updateRun(runId, { status: exitCode === 0 ? 'completed' : 'failed', endTime: new Date() });

      if (latest.current.activeRunId === runId) {
        // Whoever is looking at the finished run keeps looking at it - that is where the outcome, or
        // the reason it failed, is read - and whoever went Back is not pulled in again. Either way the
        // view reads the state from disk.
        setActiveRunId(null);
        setRunLoading(false);
        setRunningRepo(null);
      }
      reloadVisibleRuns();
    });

    const unsubscribeError = window.api.on('factory:error', (runId: string, message: string) => {
      console.error(`Run ${runId} error:`, message);
      updateRun(runId, { status: 'failed', endTime: new Date() });
      if (latest.current.activeRunId === runId) {
        // The process could not even start, so there is no run on disk to show: say why.
        setError(`The factory could not be started: ${message}`);
        setActiveRunId(null);
        setRunLoading(false);
        setRunningRepo(null);
      }
    });

    // A run exists the moment its process names it - also a round the watcher started by itself, which
    // nobody asked the screen to show. Without this it was missing from the history until the user
    // switched repository and back.
    const unsubscribeStarted = window.api.on('factory:started', () => reloadVisibleRuns());

    // A phase was merged, or the roadmap was compared with what it delivered: the project moved.
    const unsubscribeProjects = window.api.on('project:changed', (repoPath: string) => loadProjects(repoPath));

    return () => {
      unsubscribeCompleted();
      unsubscribeError();
      unsubscribeStarted();
      unsubscribeProjects();
    };
  }, []);

  /** The projects of a repository, from the factory. A repository with none (or a factory that cannot say) shows none. */
  const loadProjects = async (repoPath: string) => {
    try {
      const list = await window.api.invoke('project:list', repoPath);
      setProjectsByRepo((previous) => ({ ...previous, [repoPath]: list }));
      setProjectsError(null);
    } catch (err) {
      setProjectsError(errorText(err));
    }
  };

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

  /** Which load of each repository is the latest one: an older answer arriving late is dropped. */
  const loadSequence = useRef<Record<string, number>>({});

  const loadRunsForRepo = async (repoPath: string) => {
    const sequence = (loadSequence.current[repoPath] ?? 0) + 1;
    loadSequence.current[repoPath] = sequence;
    try {
      const factoryRuns: FactoryRun[] = await window.api.invoke('factory:list', repoPath);
      if (loadSequence.current[repoPath] !== sequence) return;

      // What is on disk is the truth, titles included: they used to be merged in from React state, which
      // is why a renamed run came back as "Untitled run" once the user switched repository.
      const loaded: Run[] = factoryRuns.map((fr) => ({
        id: fr.runId,
        repoName: fr.repoId,
        title: fr.title ?? titleFromTask(fr.task),
        ...(fr.titleSource ? { titleSource: fr.titleSource } : {}),
        ...(fr.taskId ? { taskId: fr.taskId } : {}),
        task: fr.task,
        status:
          fr.status === 'RUNNING'
            ? 'running'
            : fr.status === 'SUSPENDED'
              ? 'waiting' // parked at a gate: it needs the user
              : fr.status === 'FAILED'
                ? 'failed'
                : fr.status === 'ESCALATED_TO_HUMAN'
                  ? 'escalated'
                  : 'completed',
        startTime: new Date(fr.startedAt),
        endTime: fr.finishedAt ? new Date(fr.finishedAt) : undefined,
        error: fr.error,
        ...(fr.autoRetry ? { autoRetry: fr.autoRetry } : {}),
        rootRunId: fr.rootRunId,
        round: fr.round,
        pullRequestNumber: fr.pullRequest?.number,
        ...(fr.isolation ? { isolation: fr.isolation } : {}),
        ...(fr.phaseId ? { phaseId: fr.phaseId } : {}),
        summary: fr.tokens
          ? {
              durationMs: fr.finishedAt ? new Date(fr.finishedAt).getTime() - new Date(fr.startedAt).getTime() : 0,
              tokensUsed: fr.tokens.total,
              stepsCompleted: fr.steps?.length || 0,
            }
          : undefined,
      }));

      setRunsByRepo((previous) => ({ ...previous, [repoPath]: loaded }));
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
    setError(null); // a refusal of an earlier folder is not the answer to this one
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
      setError(`Failed to add repository: ${errorText(error)}`);
    }
  };

  const handleCloseTab = (repoName: string) => {
    const remaining = openTabs.filter((name) => name !== repoName);
    setOpenTabs(remaining);
    // Closing the tab you are on moves you to another open one - not to the one just closed, which is
    // what happened when it was the first.
    if (activeTab === repoName) setActiveTab(remaining[0] ?? null);
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
        ...(activeRepoPath ? { repoPath: activeRepoPath } : {}),
        task,
        maxAttempts: settings.global.defaultMaxAttempts,
        dryRun: settings.global.dryRunByDefault,
        pipeline: pipeline || pipelineConfig,
        isolation,
        phasing,
      });

      // It is on disk already (the factory records a run before it announces it); show it right away.
      const newRun: Run = {
        id: result.runId,
        repoName: activeTab,
        title: titleFromTask(task),
        task,
        status: 'running',
        startTime: new Date(),
        isolation,
      };
      if (activeRepoPath) {
        setRunsByRepo((previous) => ({
          ...previous,
          [activeRepoPath]: [newRun, ...(previous[activeRepoPath] ?? []).filter((run) => run.id !== newRun.id)],
        }));
      }
      setActiveRunId(result.runId); // Track active run for live output
      setOpenRunId(result.runId);
      
      // Clear task draft after successful submission
      setTaskDrafts({ ...taskDrafts, [activeTab]: '' });
    } catch (err) {
      console.error('Failed to run task:', err);
      setError(`Task execution failed: ${errorText(err)}`);
      setRunLoading(false); // Only stop loading on error during submission
      setRunningRepo(null);
    }
  };

  /**
   * Starts a run on one phase of a project. Like a task the user typed, it opens on screen straight away.
   * Rejects with the factory's reason when it cannot start (the phase before it is not merged yet, ...).
   */
  const handleStartPhase = async (_project: Project, phase: ProjectPhase) => {
    if (!activeTab || !activeRepoPath) return;
    setError(null);
    const result = await window.api.invoke('project:run-phase', { repoPath: activeRepoPath, phaseId: phase.id });

    const newRun: Run = {
      id: result.runId,
      repoName: activeTab,
      title: phase.title,
      task: phase.title,
      status: 'running',
      startTime: new Date(),
      phaseId: phase.id,
    };
    setRunsByRepo((previous) => ({
      ...previous,
      [activeRepoPath]: [newRun, ...(previous[activeRepoPath] ?? []).filter((run) => run.id !== newRun.id)],
    }));
    setRunningRepo(activeTab);
    setActiveRunId(result.runId);
    setOpenRunId(result.runId);
    loadProjects(activeRepoPath);
  };

  /** Renames a run: shown at once, stored with the run, put back if the store refuses. */
  const handleRenameRun = async (runId: string, title: string) => {
    const before = Object.values(runsByRepo).flat().find((run) => run.id === runId);
    updateRun(runId, { title, titleSource: 'user' });
    try {
      await window.api.invoke('factory:rename-run', runId, title);
    } catch (err) {
      if (before) updateRun(runId, { title: before.title, titleSource: before.titleSource });
      setError(`Rename failed: ${errorText(err)}`);
    }
  };

  const handleDeleteRun = async () => {
    if (!deleteConfirmRunId) return;

    try {
      await window.api.invoke('factory:delete', deleteConfirmRunId);
      
      // Remove from UI state
      setRunsByRepo((previous) =>
        Object.fromEntries(
          Object.entries(previous).map(([path, list]) => [path, list.filter((run) => run.id !== deleteConfirmRunId)]),
        ),
      );
      
      // Close any open views for this run
      if (selectedRunId === deleteConfirmRunId) setSelectedRunId(null);
      if (openRunId === deleteConfirmRunId) setOpenRunId(null);
      
      setDeleteConfirmRunId(null);
    } catch (err) {
      console.error('Failed to delete run:', err);
      setError(`Delete failed: ${errorText(err)}`);
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
    setRunningRepo(activeTab);
    setActiveRunId(runId);
    setOpenRunId(runId);
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
    setOpenRunId(runId);
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
      setError(`Remove failed: ${errorText(err)}`);
      setRemoveConfirmRepoName(null);
    }
  };

  const handleResumeRun = async (runId: string) => {
    setSelectedRunId(null);
    setRunningRepo(activeTab);
    setActiveRunId(runId);
    setOpenRunId(runId);
    setRunLoading(true);
    setError(null);
    updateRun(runId, { status: 'running', endTime: undefined });

    try {
      await window.api.invoke('factory:resume', { runId });
    } catch (err) {
      console.error('Failed to resume run:', err);
      setError(`Resume failed: ${errorText(err)}`);
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
      setError(`Error: ${errorText(error)}`);
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
            {/* Error - above everything else, with or without a repository open: a folder that was refused when
                it was added is said before there is any repository to show it on. */}
            {error && (
              <div className="px-6 pt-6 max-w-4xl">
                <div role="alert" className="bg-red-100 dark:bg-red-900 p-4 rounded">
                  <p className="text-red-800 dark:text-red-200 text-sm">{error}</p>
                </div>
              </div>
            )}

            {activeTab ? (
              <div className="p-6 space-y-6 max-w-4xl">
                {/* A run on screen, or the history with the pull requests and the task form */}
                {runLoading && activeTab === runningRepo && !activeRunId && !openRunId ? (
                  // Between the click and the run's id: a few seconds while the process boots.
                  <PipelineView key="starting" runId={null} isRunning pipelineConfig={pipelineConfig} />
                ) : openRunId ? (
                  <PipelineView
                    key={openRunId}
                    runId={openRunId}
                    isRunning={runLoading && activeRunId === openRunId}
                    pipelineConfig={pipelineConfig}
                    onClose={() => setOpenRunId(null)}
                    onRetry={handleResumeRun}
                    onOpenRun={handleOpenRun}
                    onTitleChanged={(runId, title, source) => updateRun(runId, { title, ...(source ? { titleSource: source } : {}) })}
                  />
                ) : (
                  <>
                    {/* Run History - shown above the task input when there's history */}
                    {repoRuns.length > 0 && (
                      <RunHistory
                        runs={repoRuns}
                        loading={false}
                        onSelectRun={handleOpenRun}
                        onResume={handleResumeRun}
                        onRename={handleRenameRun}
                        onDelete={(runId) => setDeleteConfirmRunId(runId)}
                      />
                    )}

                    <div className="space-y-4">
                      <PullRequestsPanel
                        repoPath={activeRepoPath ?? ''}
                        state={prWatch}
                        onRefresh={() => {
                          window.api.invoke('pr-watch:refresh').catch(() => {});
                        }}
                        onTriage={(key) => window.api.invoke('pr-watch:triage', key)}
                        onRevise={handlePrRevise}
                        onDismiss={(key) => window.api.invoke('pr-watch:dismiss', key)}
                        onPostReplies={(key) => window.api.invoke('pr-watch:post-replies', key)}
                        onDecideScope={(key, decisions) => window.api.invoke('pr-watch:decide-scope', key, decisions)}
                        onOpenRun={handleOpenRun}
                        onApprove={(key, headSha) => window.api.invoke('pr-watch:approve', key, headSha)}
                        onWithdrawApproval={(key) => window.api.invoke('pr-watch:withdraw-approval', key)}
                        onMergeDraft={(key) => window.api.invoke('pr-watch:merge-draft', key)}
                        onMerge={handlePrMerge}
                        notices={mergeNotices}
                        onDismissNotice={(id) => setMergeNotices((previous) => previous.filter((notice) => notice.id !== id))}
                      />

                      <RoadmapPanel
                        projects={projects}
                        error={projectsError}
                        onReload={() => activeRepoPath && loadProjects(activeRepoPath)}
                        onProjectChanged={(updated) =>
                          activeRepoPath &&
                          setProjectsByRepo((previous) => ({
                            ...previous,
                            [activeRepoPath]: (previous[activeRepoPath] ?? []).map((project) => (project.id === updated.id ? updated : project)),
                          }))
                        }
                        onStartPhase={handleStartPhase}
                      />

                      <TaskInput
                        repoName={activeTab}
                        {...(activeRepoPath ? { repoPath: activeRepoPath } : {})}
                        {...(places ? { places: { worktreesDir: places.worktreesDir, volatile: places.volatile } } : {})}
                        isolation={isolation}
                        onIsolationChange={setIsolation}
                        phasing={phasing}
                        onPhasingChange={setPhasing}
                        value={taskDrafts[activeTab] || ''}
                        onChange={(value) => setTaskDrafts({ ...taskDrafts, [activeTab]: value })}
                        onSubmit={handleRunTask}
                        loading={false}
                        hasHistory={repoRuns.length > 0}
                        pipeline={pipelineConfig}
                        onPipelineChange={setPipelineConfig}
                        {...(busyRun
                          ? {
                              blocked: {
                                message:
                                  busyRun.status === 'running'
                                    ? `"${busyRun.title}" is still running in this repository and uses the same working copy. A new task can start when it is done - or choose an isolated worktree to start it now.`
                                    : `"${busyRun.title}" is waiting for you in this repository and uses the same working copy. Answer it or close it to start a new task - or choose an isolated worktree to start it now.`,
                                onOpen: () => setOpenRunId(busyRun.id),
                              },
                            }
                          : {})}
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
        onSaved={(saved) => {
          setIsolation(saved.isolation);
          loadPlaces(); // the folders may have been changed: ask the factory where it works now
        }}
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
