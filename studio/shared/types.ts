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

export interface FactoryRun {
  runId: string;
  repoId: string;
  task: string;
  /**
   * What the run is called in the history. Named by the factory's run namer, or by the user (their name
   * always wins). Absent on runs from before titles were stored.
   */
  title?: string;
  titleSource?: 'agent' | 'fallback' | 'round' | 'user';
  /** `f0042`: one id for the task and all of its rounds. Absent on runs from before task ids. */
  taskId?: string;
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

export interface RunArtifact {
  step: string;
  attempt: number;
  status: string;
  model?: string;
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
  workspaceRoot: string;
  defaultMaxAttempts: number;
  dryRunByDefault: boolean; // Run in dry-run mode (no API calls, no git writes)

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
