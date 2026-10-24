/**
 * Shared types between Electron main process and React renderer.
 */

export type RunStatus = 
  | 'PENDING' 
  | 'RUNNING' 
  | 'DELIVERED_WITHOUT_PR' 
  | 'DELIVERED_WITH_PR' 
  | 'ESCALATED_TO_HUMAN' 
  | 'FAILED' 
  | 'SUSPENDED';

export type AgentRole = 
  | 'pm-architect' 
  | 'developer' 
  | 'qa-tester' 
  | 'triage' 
  | 'reviewer' 
  | 'security' 
  | 'documentation';

export interface Repository {
  id: string;
  name: string;
  path: string;
  lastAccessed?: string;
}

export interface RunStep {
  step: string;
  attempt: number;
  status: string;
  durationMs: number;
  artifact?: string;
}

/** Claude's usage limit, when a run stopped on it: which window ran out and when it resets. */
export interface UsageLimitInfo {
  /** ISO time, or null when the CLI did not say. */
  resetsAt: string | null;
  /** `five_hour`, `seven_day`, ... */
  window?: string;
}

/**
 * The Studio's plan to retry a run that stopped on the usage limit (`auto-retry.json` in the run
 * directory, kept by `electron/services/auto-retry.ts`).
 */
export interface AutoRetryState {
  /**
   * `scheduled`: will be retried at `retryAt`. `retrying`: the retry was started. `cancelled`: the user
   * said no. `gave-up`: retried too many times in a row and still limited.
   */
  status: 'scheduled' | 'retrying' | 'cancelled' | 'gave-up';
  /** When the retry happens (the reset plus a minute, or a guess when the reset time is unknown). */
  retryAt: string;
  resetsAt: string | null;
  window?: string;
  /** Automatic retries started since the run first stopped on the limit. */
  tries: number;
  updatedAt: string;
}

export interface FactoryRun {
  runId: string;
  repoId: string;
  task: string;
  /**
   * What the run is called in the history. Named by the factory's run namer, or by the user (their name
   * always wins). Absent on runs from before titles were stored.
   */
  title?: string;
  /** `phase`: named by the roadmap phase it implements (no model was asked). */
  titleSource?: 'agent' | 'fallback' | 'round' | 'phase' | 'user';
  /** `f0042`: one id for the task and all of its rounds. Absent on runs from before task ids. */
  taskId?: string;
  /**
   * Where the work happens: a checkout of its own (`worktree`) or the user's repository (`in-place`).
   * A run from before checkouts existed worked in place.
   */
  isolation?: 'worktree' | 'in-place';
  /** The folder the work happens in: the checkout, or the repository. */
  workPath?: string;
  /** The project and phase this run belongs to. */
  initiativeId?: string;
  phaseId?: string;
  status: RunStatus;
  attempts: number;
  branch?: string;
  startedAt: string;
  finishedAt?: string;
  tokens?: {
    total: number;
    input: number;
    output: number;
  };
  gates?: {
    qa?: string;
    codeReview?: string;
    security?: string;
    documentation?: string;
  };
  steps?: RunStep[];
  error?: string;
  /** Set when the run failed because Claude's usage limit was reached. */
  usageLimit?: UsageLimitInfo;
  /** The automatic retry of a run that stopped on the usage limit, when there is one. */
  autoRetry?: AutoRetryState;
  /**
   * Which optional stages this run executes, as recorded in its `run.json`. Absent on runs
   * created before stages were configurable.
   */
  pipeline?: PipelineConfig;
  /** Workflow step that was executing when the run failed, when it is known. */
  failedStep?: string;
  /**
   * Where this run sits in the story of its pull request. A plain run is round 1 of its own chain;
   * a *revision* continues an earlier run after review comments (see `PrWatch*`).
   */
  kind?: 'run' | 'revision' | 'pr-feedback';
  rootRunId?: string;
  parentRunId?: string;
  round?: number;
  pullRequest?: { number: number; url: string; headBranch: string; baseBranch: string };
}

/** One line of a run's `events.ndjson` (the factory's structured audit trail). */
export interface RunEventRecord {
  at: string;
  type: string;
  [key: string]: unknown;
}

/**
 * One thing an agent call did, as it did it: a line of `activity.ndjson` in the run directory (written by
 * `factory/src/utils/agent-activity.ts`). Entries of one call share `call`; text entries of one paragraph
 * share `block`.
 */
export interface ActivityEntry {
  at: string;
  call: string;
  role: string;
  step: string;
  attempt: number;
  kind:
    | 'call-start'
    | 'thinking'
    | 'text'
    | 'tool'
    | 'tool-error'
    | 'summary'
    | 'report'
    | 'notice'
    | 'call-end'
    | 'call-failed';
  text: string;
  block?: string;
  model?: string;
  backend?: string;
  tool?: string;
  durationMs?: number;
  tokens?: number;
}

/** What happened to one model on the way to a step's answer (see `factory/src/utils/model-routing.ts`). */
export interface ModelAttempt {
  model: string;
  backend: 'free-tier' | 'claude-cli' | 'api' | 'dry-run';
  outcome:
    | 'served'
    | 'rate-limit'
    | 'cooling-down'
    | 'not-configured'
    | 'auth'
    | 'not-found'
    | 'invalid'
    | 'timeout'
    | 'error';
  detail?: string;
}

/** The models a step's call went through, the one that answered last. */
export interface ModelRouting {
  requested: string;
  served: string;
  backend: ModelAttempt['backend'];
  failedOver: boolean;
  fallbackReason?: string;
  attempts: ModelAttempt[];
}

export interface RunArtifact {
  step: string;
  attempt: number;
  status: string;
  model?: string;
  /** Absent for a step that made no model call, and for runs from before routing was recorded. */
  routing?: ModelRouting;
  durationMs?: number;
  writtenAt?: string;
  data: any;
}

/**
 * Per-task pipeline configuration: which optional quality gates should run.
 * Mandatory stages (prepare, pm-architect, developer, delivery) always run.
 */
export interface PipelineConfig {
  qa: boolean;
  review: boolean;
  security: boolean;
  documentation: boolean;
  /**
   * Fix the minor findings of the gates in one checked pass. Absent in the record of a run from before
   * the pass existed: read it as `polish !== false`.
   */
  polish?: boolean;
}

/** The three human-in-the-loop gates the workflow can pause on. */
export type PendingInputReason =
  | 'CLARIFICATION_REQUIRED'
  | 'DELIVERY_APPROVAL_REQUIRED'
  | 'ESCALATION_REQUIRED';

/**
 * An open input request from a suspended run, mirrored from the workflow's suspend payload
 * to `pending-input.json` so the renderer can render the matching form.
 */
export interface PendingInput {
  reason: PendingInputReason;
  runId: string;
  step: string;

  // CLARIFICATION_REQUIRED
  questions?: string[];
  planSummary?: string;

  // DELIVERY_APPROVAL_REQUIRED
  branch?: string;
  baseBranch?: string;
  commitSha?: string | null;
  commitMessage?: string;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  pullRequestLabels?: string[];
  /** Set when the text was not written by the AI (it could not answer): read it with care. */
  pullRequestTextNote?: string;
  filesChanged?: number;
  /** Set for a further round: pushing updates this pull request instead of opening one. */
  existingPullRequest?: { number: number; url: string };
  /** The commit message can still be changed (a single, unpushed commit). */
  commitEditable?: boolean;
  commitLockedReason?: string;
  /** The branch can still be renamed (it is not on the remote yet). */
  branchEditable?: boolean;
  branchLockedReason?: string;

  // ESCALATION_REQUIRED
  escalationReason?: string;
  question?: string;
  attempt?: number;
  maxAttempts?: number;
  rootCause?: string;
}

/**
 * What the human may change at the delivery gate before anything is published. The values are
 * the *final* ones (not a diff); a field that is left out keeps the proposal.
 */
export interface DeliveryEdits {
  commitMessage?: string;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  branchName?: string;
}

/** One review comment, as classified by the feedback-triage agent. */
export interface PrFeedbackItem {
  commentId: string;
  author: string;
  excerpt: string;
  category: string;
  /** FUTURE_PHASE only: the roadmap phase it belongs to (an id), `NEW` for none, null when the triage could not tell. */
  targetPhase?: string | null;
  assignTo: string;
  reasoning: string;
  reply: string;
  filesInvolved: string[];
}

/** Outcome of triaging the review comments on a pull request (from the feedback run's summary). */
export interface PrFeedbackSummary {
  runId: string;
  pullRequest: number;
  pullRequestUrl: string;
  action: 'RERUN_IMPLEMENTATION' | 'RERUN_PLANNING' | 'REPLY_ONLY' | 'ESCALATE_HUMAN' | 'NO_FEEDBACK';
  summary: string;
  commentsTriaged: number;
  repliesPosted: number;
  /** Self-contained requirement for a follow-up run. Empty when none is needed. */
  followUpTask: string;
  blockers: string[];
  /** Branch the pull request is opened from - the follow-up run continues on it. */
  headBranch: string;
  baseBranch: string;
  items: PrFeedbackItem[];
  /** Every comment this triage looked at - how the watcher tells a stale triage from a current one. */
  commentIds: string[];
  finishedAt?: string;
}

/* -------------------------------------------------------------------------- */
/* Pull-request watcher                                                        */
/* -------------------------------------------------------------------------- */

/** A review comment nobody has dealt with yet. */
export interface PrComment {
  id: string;
  /** Inline comments only: the review thread to reply in. */
  threadId?: string;
  source: 'ISSUE_COMMENT' | 'REVIEW_BODY' | 'REVIEW_THREAD';
  author: string;
  body: string;
  createdAt: string;
  path?: string;
  line?: number;
  reviewState?: string;
  /** Written after the pull request was registered: only fresh comments start work by themselves. */
  fresh: boolean;
}

/** One pull request as reported by the factory's `pr-check` command. */
export interface PrCheckPullRequest {
  key: string;
  repoPath: string;
  repoName: string;
  number: number;
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  rootRunId: string;
  latestRunId: string;
  round: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  pending: PrComment[];
  /** The commit the branch is at on GitHub. A human's approval is bound to exactly this one. */
  headSha?: string;
  /** Why it cannot be merged right now, as judged by the factory (conflicts, draft, ...). */
  mergeBlockers?: string[];
  /** Worth knowing before merging (failing checks, ...). */
  mergeWarnings?: string[];
  error?: string;
  /** Where the task's work is. Absent from a factory older than checkouts. */
  workCopy?: WorkCopy;
  /** The project this pull request is a phase of, when it has other phases. */
  roadmap?: PullRequestRoadmap;
  /** What the user decided about comments that belong to a later phase. */
  scopeDecisions?: Array<{ commentId: string; decision: 'DEFER' | 'DO_NOW'; targetPhaseId: string | null }>;
  /** Set by the check that found the pull request over (merged or closed on GitHub). */
  settled?: { phase: SettledPhase | null; notes: string[] };
}

/** Where a task's work is, as the factory reports it. */
export interface WorkCopy {
  isolation: 'worktree' | 'in-place';
  path: string;
  /** The folder is there. */
  exists: boolean;
}

export type PhaseStatus = 'PLANNED' | 'RUNNING' | 'IN_REVIEW' | 'MERGED' | 'SKIPPED';

export interface PullRequestRoadmap {
  initiativeId: string;
  title: string;
  /** The phase this pull request is. */
  phaseId: string;
  ordinal: number;
  total: number;
  phases: Array<{ id: string; ordinal: number; title: string; status: PhaseStatus }>;
}

/** The phase a pull request was, and where its project stands after it merged (or was closed). */
export interface SettledPhase {
  initiativeId: string;
  /** `quick`: a task that was never split into phases - there is no project to speak of. */
  kind: 'quick' | 'project' | 'greenfield';
  initiativeTitle: string;
  phaseId: string;
  title: string;
  ordinal: number;
  total: number;
  merged: boolean;
  alreadySettled: boolean;
  next: { phaseId: string; ordinal: number; title: string } | null;
  initiativeDone: boolean;
}

export interface PrCheckResult {
  checkedAt: string;
  watching: number;
  backfilled: number;
  pullRequests: PrCheckPullRequest[];
}

/**
 * What the watcher is doing about a pull request that has unhandled comments.
 *
 * - `idle`              nothing to do: no unhandled comments
 * - `pending`           comments are waiting; nothing started (automation is off, or they are old)
 * - `triaging`          the triage agent is classifying them
 * - `triaged`           classified; waiting for a decision (or for a round to be started)
 * - `awaiting-scope`    some comments belong to a later phase; the user decides where each goes first
 * - `revising`          a round is running
 * - `awaiting-approval` a round is waiting for the human to approve the push
 * - `blocked`           cannot proceed without help (busy repo, dirty tree, a disagreement, a failure)
 * - `error`             the check or the triage itself failed
 */
export type PrWatchStatus =
  | 'idle'
  | 'pending'
  | 'triaging'
  | 'triaged'
  | 'awaiting-scope'
  | 'revising'
  | 'awaiting-approval'
  | 'blocked'
  | 'error';

/**
 * Where a pull request stands on being merged. The merge itself only ever happens for a pull
 * request that has no unhandled comments and no round in flight (`status: 'idle'`); this says
 * what else stands in the way, and whether the human has approved it.
 */
export interface PrMergeStatus {
  /** The commit as GitHub has it now. The approval is bound to exactly this one. */
  headSha: string | null;
  /** Why it cannot be merged right now (conflicts, draft, ...). Empty when nothing stands in the way. */
  blockers: string[];
  /** Worth knowing before merging; does not stop it. */
  warnings: string[];
  /** The human's "I reviewed it and have no comments", for exactly `headSha`. */
  approval: { headSha: string; approvedAt: string } | null;
  /** They approved an earlier commit; the branch has moved on since, so that no longer counts. */
  approvalOutdated: boolean;
}

/** The commit message a squash merge would have, as drafted by the factory. */
export interface PrMergeDraft {
  subject: string;
  body: string;
  /** `agent`: written by the model from the final diff. `fallback`: the pull request's own title and summary. */
  source: 'agent' | 'fallback';
  /** Why the fallback was used, or what the reader should know about the draft. */
  note?: string;
  /** A rehearsal: the AI was deliberately not asked. */
  dryRun?: boolean;
  pullRequest: { number: number; title: string; url: string; headBranch: string; baseBranch: string; headSha: string };
  stats: { commits: number; files: number; additions: number; deletions: number };
  blockers: string[];
  warnings: string[];
}

/** What came of a merge. */
export interface PrMergeResult {
  merged: boolean;
  /** A rehearsal: everything was checked, nothing was merged. */
  dryRun?: boolean;
  /** Why nothing was merged. */
  reason?: string;
  mergeCommit?: string;
  baseBranch?: string;
  headBranch?: string;
  /** What else happened - or deliberately did not - around the merge, in plain language. */
  notes: string[];
  /** The phase of a project this pull request was, and what comes next in it. */
  phase?: SettledPhase;
}

/** A merge the user just did, kept on screen until they dismiss it (the pull request itself is gone). */
export interface PrMergeNotice {
  id: string;
  repoPath: string;
  number: number;
  title: string;
  url: string;
  at: string;
  result: PrMergeResult;
}

export interface WatchedPullRequest {
  key: string;
  repoPath: string;
  repoName: string;
  number: number;
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  /** The run that opened the pull request. */
  rootRunId: string;
  /** The run a new round would continue from. */
  latestRunId: string;
  round: number;
  pending: PrComment[];
  status: PrWatchStatus;
  /** Plain-language explanation of the status. */
  message: string;
  /** Where the task's work is (its own checkout, or the user's repository). */
  workCopy?: WorkCopy;
  /** The project this pull request is a phase of, when it has other phases. */
  roadmap?: PullRequestRoadmap;
  /** Comments about a later phase: which wait for the user, which they said to do in this pull request. */
  scope?: PrScopeView;
  /** Whether it can be merged, and whether the human approved it. */
  merge: PrMergeStatus;
  triage?: PrFeedbackSummary | null;
  /** The round in progress, if any. */
  revisionRunId?: string | null;
  /**
   * The last round failed, so starting it again makes sense. A round that is only waiting for the
   * user (an answer, an approval) is not retryable: starting another one would collide with it.
   */
  retryable?: boolean;
}

/** A review comment that belongs to a later phase, waiting for the user to say where it goes. */
export interface PrScopeComment {
  id: string;
  author: string;
  /** The comment as written. */
  body: string;
  /** The triage's short quote of it. */
  excerpt: string;
  path?: string;
  line?: number;
  /** The phase the triage thinks it belongs to (an id), `NEW`, or null when it could not tell. */
  suggestedPhaseId: string | null;
}

export interface PrScopeView {
  /** Not decided yet: the pull request waits for these. */
  undecided: PrScopeComment[];
  /** The user said to do these in this pull request: they go into the next round. */
  doNow: string[];
}

export interface PrWatchSettings {
  /** Look for review comments in the background. */
  enabled: boolean;
  intervalSeconds: number;
  /** Classify new comments as soon as they appear (one cheap agent call). */
  autoTriage: boolean;
  /** Start a round when the triage says code has to change (costs tokens; still asks before pushing). */
  autoRevise: boolean;
  /** Answer reviewers on GitHub: questions after triage, requested changes once they are pushed. */
  replyOnGitHub: boolean;
}

/**
 * Per-repository overrides of the pull-request automation. A key that is missing means "use the
 * default" - which is not the same as a stored `false`, and is what lets a changed default reach
 * every repository that never chose for itself.
 */
export type RepoPrWatchOverrides = Partial<Pick<PrWatchSettings, 'autoTriage' | 'autoRevise' | 'replyOnGitHub'>>;

/** Everything the Settings screen edits about pull requests, in one piece. */
export interface PrWatchSettingsBundle {
  /** Applies to every repository, and decides whether (and how often) GitHub is checked at all. */
  defaults: PrWatchSettings;
  /** Keyed by repository name (the folder name shown in the sidebar). */
  repos: Record<string, RepoPrWatchOverrides>;
}

export interface PrWatchState {
  /** The defaults; a repository may override the automatic steps (see `RepoPrWatchOverrides`). */
  settings: PrWatchSettings;
  checking: boolean;
  lastCheckedAt: string | null;
  /** Open pull requests being watched. */
  watching: number;
  /** Only the ones that need attention: pending comments, or work in progress. */
  pullRequests: WatchedPullRequest[];
  /** The check itself failed (e.g. `gh` is not installed). */
  error: string | null;
}

export interface AgentEvent {
  type: 'agent_call' | 'tool_use' | 'step_completed' | 'suite_executed' | 'build_executed' | 'gate_result';
  runId: string;
  timestamp: string;
  role?: AgentRole;
  model?: string;
  data: any;
}

export interface AuthProvider {
  id: 'claude-cli' | 'anthropic-api' | 'google-ai' | 'openai';
  name: string;
  status: 'authenticated' | 'expired' | 'not-configured';
  details?: string;
}

export interface GlobalSettings {
  theme: 'dark' | 'light' | 'system';
  /** Where repositories are found by name. A repository anywhere else works too: it is added in the sidebar. */
  workspaceRoot: string;
  /**
   * Where each task's checkout is made. Absent or empty: the factory's own default, `<workspace>/.factory/worktrees`.
   * Somewhere that survives a restart - not the temporary folder.
   */
  worktreesDir?: string;
  defaultMaxAttempts: number;
  dryRunByDefault: boolean; // Run in dry-run mode (no API calls, no git writes)
  /**
   * Where a task works unless the task form says otherwise: a checkout of its own (the default, your
   * repository is not touched) or your repository itself.
   */
  isolation?: 'worktree' | 'in-place';
  /** Compare the roadmap with what a phase delivered as soon as it is merged (default: on; one cheap model call). */
  autoReconcile?: boolean;
  /** Retry a run that stopped on Claude's usage limit by itself, once the limit resets (default: on). */
  autoRetryOnUsageLimit?: boolean;

  logLevel: 'debug' | 'info' | 'warn' | 'error';
  activeProvider: 'claude-cli' | 'api';
  savedRepositories?: Array<{ name: string; path: string }>; // Manually added repos
}

export interface RepoSettings {
  repoId: string;
  testCommand?: string;
  buildCommand?: string;
  maxAttempts?: number;
  models?: Partial<Record<AgentRole, string>>;
  /** Overrides of the pull-request automation defaults, for this repository only. */
  prWatch?: RepoPrWatchOverrides;
}

export interface Settings {
  global: GlobalSettings;
  repos: Record<string, RepoSettings>;
  prWatch?: Partial<PrWatchSettings>;
}

/* -------------------------------------------------------------------------- */
/* Projects (initiatives) and their phases                                     */
/* -------------------------------------------------------------------------- */

export interface ProjectPhase {
  id: string;
  ordinal: number;
  title: string;
  goal: string;
  scope: string[];
  acceptance: string[];
  status: PhaseStatus;
  /** Ids of the phases that must be delivered first. */
  dependsOn: string[];
  taskId: string | null;
  rootRunId: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /** What the phase delivered, once merged. Empty until the roadmap has been compared with it. */
  summary: string | null;
  notes: Array<{ at: string; source: string; text: string }>;
  /** It can be started now. */
  ready: boolean;
  /** A phase that waits but cannot start: what it is waiting for. */
  blockedReason: string | null;
}

export interface ProjectBacklogItem {
  id: string;
  text: string;
  severity: string;
  source: string;
  phaseId: string | null;
  suggestedPhaseId: string | null;
}

export interface Project {
  id: string;
  title: string;
  goal: string;
  kind: 'quick' | 'project' | 'greenfield';
  status: 'ACTIVE' | 'DONE' | 'ARCHIVED';
  phases: ProjectPhase[];
  /** The phase the user would start next. */
  nextPhaseId: string | null;
  /** What is still open in the backlog. */
  backlog: ProjectBacklogItem[];
}

/** What the user can change in a roadmap (the factory checks it and refuses what would rewrite history). */
export interface ProjectEdit {
  title?: string;
  goal?: string;
  status?: 'ACTIVE' | 'ARCHIVED';
  phases?: Array<{
    id: string;
    title?: string;
    goal?: string;
    scope?: string[];
    acceptance?: string[];
    status?: 'PLANNED' | 'SKIPPED';
  }>;
  addPhases?: Array<{ title: string; goal?: string; scope?: string[]; acceptance?: string[] }>;
  backlog?: Array<{ id: string; status: 'OPEN' | 'DISMISSED' | 'PROMOTED'; phaseId?: string }>;
}

/** What comparing a merged phase with the roadmap concluded. */
export interface PhaseReconcileReport {
  summary: string;
  changes: Array<{ phaseId: string; ordinal: number; status: 'DONE' | 'PARTIAL'; note: string }>;
  backlogAdded: number;
  source: 'agent' | 'none';
  note?: string;
}

/** The outcome of one decision about a review comment that belongs to a later phase. */
export interface ScopeDecisionResult {
  commentId: string;
  decision: 'DEFER' | 'DO_NOW';
  ok: boolean;
  error?: string;
  target?: { phaseId: string; ordinal: number; title: string; created: boolean };
  alreadyDecided?: boolean;
  replied?: boolean;
  replyError?: string;
}

/* -------------------------------------------------------------------------- */
/* Where a task works                                                          */
/* -------------------------------------------------------------------------- */

/** Where one run's work is, and what is in it - read from the run's record and the folder itself. */
export interface WorktreeInfo {
  runId: string;
  isolation: 'worktree' | 'in-place';
  /** The checkout, or the user's repository. */
  path: string;
  branch: string | null;
  /** The folder is there (a checkout is removed when its pull request is over). */
  exists: boolean;
  /** Files with changes that are not committed (0 when the folder is gone). */
  changedFiles: number;
}

/** Where the factory works, as the factory itself says it (the `places` command). */
export interface Places {
  /** Where a repository is found by name. */
  workspaceRoot: string;
  /** Where each task's checkout is made. */
  worktreesDir: string;
  /** The repositories the Studio opened, which the factory may work on wherever they are. */
  extraRepositories: string[];
  /** The folder of checkouts is under the system's temporary folder: a restart can clear it, with any work in it that is not committed. */
  volatile: boolean;
  /** Places the environment the Studio was started with decides: the fields in Settings do not apply to them. */
  fixedBy: string[];
}

/** One of the factory's checkouts of a repository (from `worktree-list`). */
export interface WorktreeReport {
  path: string;
  taskId: string;
  branch: string | null;
  exists: boolean;
  registered: boolean;
  changedFiles: number;
  title: string | null;
  rootRunId: string | null;
  pullRequest: { number: number; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED' } | null;
  stale: boolean;
}
