/**
 * IPC channel definitions for type-safe communication between main and renderer.
 */

import type {
  AgentEvent,
  AuthProvider,
  DeliveryEdits,
  FactoryRun,
  PendingInput,
  PhaseReconcileReport,
  Places,
  PrMergeDraft,
  PrMergeResult,
  PrWatchSettings,
  PrWatchSettingsBundle,
  PrWatchState,
  Project,
  ProjectEdit,
  Repository,
  RunArtifact,
  RunEventRecord,
  ScopeDecisionResult,
  Settings,
  WorktreeInfo,
  WorktreeReport,
} from './types';

export interface IPCChannels {
  // Repository management
  'repo:list': () => Promise<Repository[]>;
  'repo:add': (path: string) => Promise<Repository>;
  'repo:browse': () => Promise<Repository | null>;
  'repo:remove': (id: string) => Promise<void>;
  'repo:select': (path: string) => Promise<void>;

  // Factory operations
  'factory:run': (params: {
    repoPath: string;
    task: string;
    criteria?: string[];
    maxAttempts?: number;
    branch?: string;
  }) => Promise<{ runId: string }>;
  'factory:run-task': (params: {
    repo: string;
    /**
     * Where the repository is. Lets the main process refuse a task while another run uses the same
     * working copy - two runs would switch each other's branch.
     */
    repoPath?: string;
    task: string;
    maxAttempts?: number;
    dryRun?: boolean;
    pipeline?: { qa?: boolean; review?: boolean; security?: boolean; documentation?: boolean; polish?: boolean };
    /** Where the task works. Omitted: the default in Settings. */
    isolation?: 'worktree' | 'in-place';
    /** Whether the architect may split a big request into phases. Omitted: it decides. */
    phasing?: 'auto' | 'on' | 'off';
  }) => Promise<{ runId: string }>;
  'factory:resume': (params: {
    runId: string;
    decision?: 'ACKNOWLEDGE' | 'ABORT';
    guidance?: string;
    clarifications?: string;
    step?: string;
  }) => Promise<void>;
  'factory:list': (repoPath?: string) => Promise<FactoryRun[]>;
  'factory:list-repos': () => Promise<Array<{ name: string; path: string; recentRuns: number }>>;
  'factory:remove-repo': (repoName: string) => Promise<void>;
  'factory:get': (runId: string) => Promise<FactoryRun | null>;
  'factory:get-artifacts': (runId: string) => Promise<RunArtifact[]>;
  /** The factory's structured audit trail (`events.ndjson`) - human answers, suspensions, delivery actions. */
  'factory:get-events': (runId: string) => Promise<RunEventRecord[]>;
  /**
   * Console output of a run, persisted by the main process so a view that mounts later (after a
   * repo switch, or when opening a finished run) can replay it. `fromLine` makes polling
   * incremental; omit it for the most recent lines.
   */
  'factory:get-output': (
    runId: string,
    fromLine?: number,
  ) => Promise<{ lines: string[]; total: number }>;
  'factory:cancel': (runId: string) => Promise<void>;
  'factory:delete': (runId: string) => Promise<void>;
  /** Renames a run in the history. Stored with the run, so it survives restarts and switching repository. */
  'factory:rename-run': (runId: string, title: string) => Promise<void>;

  // Projects: a big request split into phases, each its own pull request
  /** The projects of a repository (single-task ones are left out), with which phase can start. */
  'project:list': (repoPath: string) => Promise<Project[]>;
  /** Changes a roadmap. Resolves with the project as it is now; rejects with the reason when it was refused. */
  'project:edit': (projectId: string, edit: ProjectEdit) => Promise<Project>;
  /** Starts a run on one phase of a roadmap. */
  'project:run-phase': (params: {
    repoPath: string;
    phaseId: string;
    /** Notes for this run, added to the phase's own request. */
    notes?: string;
    isolation?: 'worktree' | 'in-place';
    pipeline?: { qa?: boolean; review?: boolean; security?: boolean; documentation?: boolean; polish?: boolean };
  }) => Promise<{ runId: string }>;
  /** Compares a merged phase with the phases to come (one cheap model call). Resolves with null when there was nothing to do. */
  'project:reconcile': (phaseId: string, options?: { force?: boolean }) => Promise<PhaseReconcileReport | null>;

  // Where a task works. Every channel takes a RUN, never a path: the main process looks the folder up,
  // so a screen can only ever act on a checkout that belongs to a run.
  'worktree:info': (runId: string) => Promise<WorktreeInfo | null>;
  /** Shows the folder in the file manager. */
  'worktree:open': (runId: string) => Promise<void>;
  /** Removes the task's checkout (the branch stays). Refuses one with uncommitted changes unless `force`. */
  'worktree:remove': (runId: string, options?: { force?: boolean }) => Promise<{ removed: boolean; message?: string }>;
  /** Moves the task's branch from its checkout to the user's repository, to run it where they work. */
  'worktree:checkout': (runId: string) => Promise<{ ok: boolean; branch?: string; error?: string }>;
  /** Every checkout the factory made for a repository. */
  'worktree:list': (repoPath: string) => Promise<WorktreeReport[]>;
  /** Where the factory works: the workspace, the folder of checkouts, and whether that folder survives a restart. */
  'places:get': () => Promise<Places>;
  /** Removes the clean checkouts whose pull request is over. */
  'worktree:gc': (repoPath: string) => Promise<{ removed: string[]; kept: Array<{ path: string; message: string }> }>;

  // Pull-request watcher: review comments are looked for in the background
  'pr-watch:get': () => Promise<PrWatchState>;
  /** Check now instead of waiting for the next interval. */
  'pr-watch:refresh': () => Promise<void>;
  /** The defaults and every repository's overrides, as the Settings screen edits them. */
  'pr-watch:get-settings': () => Promise<PrWatchSettingsBundle>;
  /** Saves them. Either part may be left out; `repos`, when given, replaces all overrides. */
  'pr-watch:save-settings': (bundle: {
    defaults?: Partial<PrWatchSettings>;
    repos?: PrWatchSettingsBundle['repos'];
  }) => Promise<PrWatchSettingsBundle>;
  'pr-watch:triage': (key: string) => Promise<void>;
  /**
   * Says where review comments that belong to a later phase go: `DEFER` to a phase (an id, or `NEW`;
   * omitted: the one the triage suggested), or `DO_NOW` in this pull request.
   */
  'pr-watch:decide-scope': (
    key: string,
    decisions: Array<{ commentId: string; decision: 'DEFER' | 'DO_NOW'; targetPhase?: string | null }>,
  ) => Promise<ScopeDecisionResult[]>;
  /** Start a round. `task` / `action` override what the triage recommended. */
  'pr-watch:revise': (
    key: string,
    options?: { task?: string; action?: 'RERUN_IMPLEMENTATION' | 'RERUN_PLANNING' },
  ) => Promise<{ runId: string }>;
  /** Set the pending comments aside (they will not be acted on). */
  'pr-watch:dismiss': (key: string) => Promise<void>;
  /** Post the drafted replies of the last triage on GitHub. */
  'pr-watch:post-replies': (key: string) => Promise<void>;
  /**
   * "I reviewed this pull request and have no comments." Bound to `headSha` - the commit the
   * screen showed - so an approval can never carry over to code the human has not seen.
   */
  'pr-watch:approve': (key: string, headSha: string) => Promise<void>;
  'pr-watch:withdraw-approval': (key: string) => Promise<void>;
  /** Writes the commit message a squash merge would have. Changes nothing on GitHub. */
  'pr-watch:merge-draft': (key: string) => Promise<PrMergeDraft>;
  /** Squash-merges the approved pull request with the (possibly edited) message. */
  'pr-watch:merge': (
    key: string,
    input: { subject: string; body: string; deleteBranch: boolean },
  ) => Promise<PrMergeResult>;
  /** The rounds of one task, oldest first - the run itself and every revision of it. */
  'factory:get-rounds': (runId: string) => Promise<
    Array<{ runId: string; round: number; status: FactoryRun['status']; startedAt: string; kind: string }>
  >;

  // Human-in-the-loop gates
  'factory:get-pending-input': (runId: string) => Promise<PendingInput | null>;
  'factory:submit-input': (params: {
    runId: string;
    clarifications?: string;
    decision?: 'ACKNOWLEDGE' | 'ABORT';
    guidance?: string;
    approvePush?: boolean;
    approvePullRequest?: boolean;
    /** Delivery gate: the human's final commit message / PR title / PR description / branch name. */
    edits?: DeliveryEdits;
  }) => Promise<void>;

  // Real-time events
  'factory:subscribe': (runId: string) => Promise<void>;
  'factory:unsubscribe': (runId: string) => Promise<void>;

  // Authentication
  'auth:status': () => Promise<AuthProvider[]>;
  'auth:login': (provider: 'claude-cli') => Promise<boolean>;
  'auth:refresh': () => Promise<boolean>;
  'auth:setApiKey': (provider: 'anthropic-api' | 'google-ai', key: string) => Promise<boolean>;

  // Settings
  'settings:get': () => Promise<Settings>;
  'settings:update': (settings: Partial<Settings>) => Promise<void>;
  'settings:getRepo': (repoId: string) => Promise<Settings['repos'][string] | null>;
  'settings:updateRepo': (repoId: string, settings: Partial<Settings['repos'][string]>) => Promise<void>;

  // Diff viewer
  'diff:get': (repoPath: string, runId?: string) => Promise<{ files: string[]; diff: string }>;

  // Logs
  'logs:get': (runId: string) => Promise<{ path: string; content: string }[]>;
  'logs:tail': (runId: string, file: string) => Promise<string>;
}

// Events that flow from main to renderer
export interface IPCEvents {
  'agent:event': (event: AgentEvent) => void;
  'run:status': (runId: string, status: FactoryRun['status']) => void;
  'auth:changed': (providers: AuthProvider[]) => void;
  /** The watcher's view changed (new comments, a job started / finished, ...). */
  'pr-watch:changed': (state: PrWatchState) => void;
  'factory:output': (runId: string, data: string) => void;
  /**
   * A factory process has announced its run id: the run exists on disk. Sent for every run, including a
   * round the watcher starts by itself, so the history can show it at once.
   */
  'factory:started': (runId: string) => void;
  /** A project's roadmap changed (a phase was settled, or compared with what it delivered): look again. */
  'project:changed': (repoPath: string) => void;
  /** `reason` accompanies a failure: the last meaningful line the process printed. */
  'factory:completed': (runId: string, exitCode: number, reason?: string) => void;
  'factory:error': (runId: string, error: string) => void;
  'auth:login-started': (provider: string) => void;
  'auth:login-completed': (provider: string, success: boolean) => void;
}
