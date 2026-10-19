/**
 * Watches the pull requests the factory opened and reacts to review comments left on them.
 *
 * Every interval (and right after a delivery, see `poke`) it asks the factory which open pull
 * requests have comments nobody has dealt with. What happens next is the user's choice, in
 * increasing order of side effects:
 *
 *   detect      always - just lists them, nothing else happens
 *   auto-triage one agent call classifies the new comments; read-only
 *   auto-revise a further round (developer, QA, review, ...) addresses the ones that need code;
 *               it still stops at the delivery gate, so nothing is pushed without approval
 *   replies     answering reviewers on GitHub (public), opt-in
 *
 * Everything the decisions depend on is injected (`WatcherDeps`), so the logic that decides
 * *whether to start something* - the part that can cost tokens or loop - is tested without
 * Electron, a network or a model.
 */
import path from 'node:path';
import type {
  PrCheckPullRequest,
  PrCheckResult,
  PrComment,
  PrFeedbackSummary,
  PrMergeDraft,
  PrMergeResult,
  PrMergeStatus,
  PrWatchSettings,
  PrWatchSettingsBundle,
  PrWatchState,
  PrWatchStatus,
  RepoPrWatchOverrides,
  WatchedPullRequest,
} from '../../shared/types';

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 3600;

export const DEFAULT_PR_WATCH_SETTINGS: PrWatchSettings = {
  enabled: true,
  intervalSeconds: 60,
  autoTriage: true,
  autoRevise: true,
  replyOnGitHub: false,
};

/** Fills gaps with the defaults and keeps every value inside its allowed range. */
export function normalizePrWatchSettings(raw: Partial<PrWatchSettings> | undefined): PrWatchSettings {
  const merged = { ...DEFAULT_PR_WATCH_SETTINGS, ...(raw ?? {}) };
  const interval = Number(merged.intervalSeconds);
  return {
    enabled: merged.enabled !== false,
    intervalSeconds: Number.isFinite(interval)
      ? Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.round(interval)))
      : DEFAULT_PR_WATCH_SETTINGS.intervalSeconds,
    autoTriage: merged.autoTriage !== false,
    autoRevise: merged.autoRevise !== false,
    replyOnGitHub: merged.replyOnGitHub === true,
  };
}

const OVERRIDABLE = ['autoTriage', 'autoRevise', 'replyOnGitHub'] as const;

/**
 * Keeps only what a repository may override, and only real booleans. Anything else - a missing key,
 * a string like "yes", null - means "use the default", never "on": publishing replies on GitHub
 * must not switch on because a settings file held something unexpected.
 */
export function normalizeRepoOverrides(raw: unknown): RepoPrWatchOverrides {
  const overrides: RepoPrWatchOverrides = {};
  if (raw && typeof raw === 'object') {
    for (const key of OVERRIDABLE) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === 'boolean') overrides[key] = value;
    }
  }
  return overrides;
}

/** Overrides per repository name; repositories that override nothing are left out. */
export function normalizeRepoOverridesMap(raw: unknown): Record<string, RepoPrWatchOverrides> {
  const result: Record<string, RepoPrWatchOverrides> = {};
  if (raw && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      const overrides = normalizeRepoOverrides(value);
      if (Object.keys(overrides).length > 0) result[name] = overrides;
    }
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Dependencies                                                                */
/* -------------------------------------------------------------------------- */

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A round (a revision run) of a pull request, as found on disk. */
export interface RoundInfo {
  runId: string;
  round: number;
  /** RUNNING | SUSPENDED | FAILED | DELIVERED | DELIVERED_WITHOUT_PR | ... */
  status: string;
  error?: string;
  /** Which human gate a SUSPENDED round is waiting on. */
  waitingFor?: string;
}

export interface BusyRun {
  runId: string;
  reason: 'running' | 'waiting';
  /** What the run is for, when it is known (a run that has only just started has not written it yet). */
  task?: string;
}

/**
 * A round this watcher has started whose own record is not on disk yet. The factory announces a
 * run's id as soon as it starts, but only writes the record (`run.json`) a moment later, after
 * checking the repository - and nothing looks at the disk again until the next poll.
 */
export interface StartedRound {
  runId: string;
  round: number;
}

/** The human's approval of one pull request, bound to the commit they were shown. */
export interface Approval {
  headSha: string;
  approvedAt: string;
}

/** What the watcher remembers between restarts, so a restart never repeats work or retries a failure. */
export interface WatcherMemory {
  /** Last comment set a triage was attempted for, per pull request. */
  triageAttempts: Record<string, string>;
  /** Last comment set a round was started for, per pull request. */
  reviseAttempts: Record<string, string>;
  /**
   * "I reviewed it and have no comments", per pull request. Remembered across restarts: it is a
   * decision the human took, not a cache.
   */
  approvals: Record<string, Approval>;
}

export interface WatcherDeps {
  /** Runs the factory CLI to completion. */
  runCli(args: string[], options?: { timeoutMs?: number }): Promise<CliResult>;
  /**
   * Starts a long-running factory run (a round) and resolves once its run id is known.
   * `userInitiated` lets the caller ask the user to sign in; a background start must never do that.
   */
  startRun(args: string[], options: { userInitiated: boolean }): Promise<{ runId: string }>;
  /** A run that is using this repository's working copy right now (running, or waiting for a human). */
  findBusyRun(repoPath: string): BusyRun | null;
  /** Is the process of this run still going? (A run's directory outlives its process.) */
  isRunActive(runId: string): boolean;
  /** The rounds of this pull request, newest first. */
  listRounds(repoPath: string, number: number, sinceRunId: string): RoundInfo[];
  latestTriage(repoPath: string, number: number): PrFeedbackSummary | null;
  /** No uncommitted changes (the factory refuses to start on a dirty working tree). */
  isClean(repoPath: string): Promise<boolean>;
  /** Run everything offline with stubbed models (the Studio's "dry run by default" setting). */
  isDryRun(): boolean;
  loadSettings(): Partial<PrWatchSettings> | undefined;
  saveSettings(settings: PrWatchSettings): void;
  /** Per-repository overrides, keyed by repository name. */
  loadRepoOverrides(): Record<string, RepoPrWatchOverrides> | undefined;
  saveRepoOverrides(overrides: Record<string, RepoPrWatchOverrides>): void;
  loadMemory(): WatcherMemory;
  saveMemory(memory: WatcherMemory): void;
  emit(state: PrWatchState): void;
  now(): number;
  log?(message: string): void;
}

/* -------------------------------------------------------------------------- */
/* Pure decisions                                                              */
/* -------------------------------------------------------------------------- */

const signatureOf = (pending: PrComment[]): string => pending.map((c) => c.id).sort().join(',');

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * How a run is named in a message. The id alone says nothing to a person (it is not shown
 * anywhere else), so the task it is for comes first when it is known.
 */
export function nameOfRun(run: BusyRun): string {
  const task = run.task?.replace(/\s+/g, ' ').trim();
  if (!task) return `run ${run.runId}`;
  return `"${task.length > 60 ? `${task.slice(0, 57)}...` : task}" (run ${run.runId})`;
}

const REVISION_ACTIONS = new Set(['RERUN_IMPLEMENTATION', 'RERUN_PLANNING']);

export interface ClassifyInput {
  pr: PrCheckPullRequest;
  inFlightTriage: boolean;
  jobError: { message: string; signature: string } | undefined;
  /** Newest first. */
  rounds: RoundInfo[];
  triage: PrFeedbackSummary | null;
  busy: BusyRun | null;
  /** A round we started that has no record on disk yet (see `StartedRound`). */
  starting?: StartedRound | undefined;
  /** The comment set a round was last started for. */
  attemptedRevise: string | undefined;
  settings: PrWatchSettings;
}

export interface Classification {
  status: PrWatchStatus;
  message: string;
  revisionRunId?: string;
  /** The last round failed and may be started again. */
  retryable?: boolean;
  /** The triage, when it covers every comment that is pending now. */
  triage: PrFeedbackSummary | null;
}

/**
 * Where a pull request stands on being merged: what GitHub says (judged by the factory, once, in
 * `pr-check`) and whether the human approved *this* commit. Pure.
 *
 * An approval counts only for the commit it was given for. When the branch moves - a round pushed,
 * a suggestion committed on GitHub - the approval is outdated and the question is asked again.
 */
export function mergeStatusOf(pr: PrCheckPullRequest, approval: Approval | undefined): PrMergeStatus {
  const headSha = pr.headSha ?? null;
  const current = approval && headSha !== null && approval.headSha === headSha ? approval : null;
  return {
    headSha,
    blockers:
      pr.mergeBlockers ?? (headSha === null ? ['GitHub has not reported the latest commit of this pull request yet.'] : []),
    warnings: pr.mergeWarnings ?? [],
    approval: current ? { headSha: current.headSha, approvedAt: current.approvedAt } : null,
    approvalOutdated: approval !== undefined && current === null,
  };
}

/** Does the triage cover every comment that is pending right now? A stale one must not be acted on. */
export function triageCovers(triage: PrFeedbackSummary | null, pending: PrComment[]): boolean {
  if (!triage || pending.length === 0) return false;
  const seen = new Set(triage.commentIds);
  return pending.every((comment) => seen.has(comment.id));
}

/** Where a pull request stands, in plain language. Pure: no I/O, no clock. */
export function classifyPullRequest(input: ClassifyInput): Classification {
  const { pr, rounds, settings } = input;
  const pending = pr.pending;
  const covering = triageCovers(input.triage, pending) ? input.triage : null;

  // 1. A round is in progress - that is what the user needs to know about.
  const active = rounds.find((round) => round.status === 'RUNNING' || round.status === 'SUSPENDED');
  if (active) {
    if (active.status === 'RUNNING') {
      return {
        status: 'revising',
        message: `Round ${active.round} is addressing the review comments.`,
        revisionRunId: active.runId,
        triage: covering,
      };
    }
    return active.waitingFor === 'DELIVERY_APPROVAL_REQUIRED'
      ? {
          status: 'awaiting-approval',
          message: `Round ${active.round} is ready - approve the push to update the pull request.`,
          revisionRunId: active.runId,
          triage: covering,
        }
      : {
          status: 'blocked',
          message: `Round ${active.round} needs your input before it can continue.`,
          revisionRunId: active.runId,
          triage: covering,
        };
  }

  // A round we have just started: its process is going, but it has not written its record yet.
  // Without this the card would say "waiting for run X" about the very round that was started.
  if (input.starting) {
    return {
      status: 'revising',
      message: `Round ${input.starting.round} is addressing the review comments.`,
      revisionRunId: input.starting.runId,
      triage: covering,
    };
  }

  if (input.inFlightTriage) {
    return {
      status: 'triaging',
      message: `Reading ${plural(pending.length, 'comment', 'comments')}...`,
      triage: null,
    };
  }

  if (pr.error) {
    return { status: 'error', message: `Could not check this pull request: ${pr.error}`, triage: null };
  }

  if (pending.length === 0) {
    return { status: 'idle', message: 'No unhandled review comments.', triage: null };
  }

  const signature = signatureOf(pending);
  if (input.jobError && input.jobError.signature === signature) {
    return { status: 'error', message: input.jobError.message, triage: covering };
  }

  // 2. The last round for exactly these comments did not finish the job.
  const last = rounds[0];
  if (last && input.attemptedRevise === signature) {
    if (last.status === 'FAILED') {
      return {
        status: 'blocked',
        message: `Round ${last.round} failed: ${last.error ?? 'see the run for details'}. Fix the cause, then start it again.`,
        revisionRunId: last.runId,
        retryable: true,
        triage: covering,
      };
    }
    return {
      status: 'triaged',
      message: `Round ${last.round} finished, but nothing was pushed - the comments are still open.`,
      revisionRunId: last.runId,
      triage: covering,
    };
  }

  // 3. Classified, waiting for the next step.
  if (covering) {
    const needsCode = REVISION_ACTIONS.has(covering.action);
    const n = plural(pending.length, 'comment', 'comments');
    const needs = pending.length === 1 ? 'needs' : 'need';

    if (covering.action === 'ESCALATE_HUMAN' || (needsCode && covering.blockers.length > 0)) {
      const why = covering.blockers[0] ?? covering.summary;
      return { status: 'triaged', message: `A human has to decide first: ${why}`, triage: covering };
    }
    if (needsCode) {
      if (input.busy) {
        const waiting = input.busy.reason === 'running' ? 'to finish' : 'to be approved or closed';
        return {
          status: 'triaged',
          message: `${n} ${needs} code changes. Waiting for ${nameOfRun(input.busy)} ${waiting} - it uses the same working copy.`,
          triage: covering,
        };
      }
      return {
        status: 'triaged',
        message: settings.autoRevise
          ? `${n} ${needs} code changes - a round will start automatically.`
          : `${n} ${needs} code changes - start a round to address them.`,
        triage: covering,
      };
    }
    return {
      status: 'triaged',
      message: covering.action === 'NO_FEEDBACK' ? 'Nothing to act on.' : 'No code changes needed - these are questions or notes.',
      triage: covering,
    };
  }

  // 4. Nobody has looked at them yet.
  const fresh = pending.filter((comment) => comment.fresh).length;
  return {
    status: 'pending',
    message:
      fresh > 0
        ? `${plural(fresh, 'new comment', 'new comments')} to look at.`
        : `${plural(pending.length, 'older comment', 'older comments')} (written before the factory started watching) - triage them to act on them.`,
    triage: null,
  };
}

/** Extracts the JSON the `pr-check` command prints behind a marker, ignoring any log noise around it. */
export function parseMarkerLine<T>(stdout: string, marker: string): T | null {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith(`${marker} `)) continue;
    try {
      return JSON.parse(line.slice(marker.length + 1)) as T;
    } catch {
      return null;
    }
  }
  return null;
}

/** The most useful single line of a failed command's output. */
export function summarizeFailure(result: CliResult): string {
  const noise = /^\s*(at\s|trace_id|span_id|\[ModelRouter\])/;
  const lines = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !noise.test(line) && !line.startsWith('PR_'));
  return lines[lines.length - 1] ?? `The command failed (exit ${result.code}).`;
}

/* -------------------------------------------------------------------------- */
/* The watcher                                                                 */
/* -------------------------------------------------------------------------- */

const FIRST_CHECK_DELAY_MS = 3_000;
const POKE_DEBOUNCE_MS = 1_500;
const CHECK_TIMEOUT_MS = 120_000;
const TRIAGE_TIMEOUT_MS = 15 * 60_000;
/** One short agent call, and a few `gh` / `git` round trips. */
const MERGE_DRAFT_TIMEOUT_MS = 5 * 60_000;
const MERGE_TIMEOUT_MS = 5 * 60_000;
/** Goes through the command line as one argument; far below what the OS allows for one. */
const MAX_COMMIT_BODY_CHARS = 50_000;

const STATUS_ORDER: Record<PrWatchStatus, number> = {
  'awaiting-approval': 0,
  blocked: 1,
  error: 2,
  revising: 3,
  triaging: 4,
  triaged: 5,
  pending: 6,
  idle: 7,
};

export class PrWatcher {
  /** The defaults. Whether to watch at all, and how often, is decided here and only here. */
  private settings: PrWatchSettings;
  private repoOverrides: Record<string, RepoPrWatchOverrides>;
  private memory: WatcherMemory;
  private lastCheck: PrCheckResult | null = null;
  private lastCheckedAt: string | null = null;
  private checkError: string | null = null;
  private checking = false;
  private views: WatchedPullRequest[] = [];

  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pokeTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;

  /** Pull requests with a triage queued or running. */
  private readonly triaging = new Set<string>();
  private triageQueue: Promise<void> = Promise.resolve();
  /** Pull requests a round is being started for right now (a double click must not start two). */
  private readonly starting = new Set<string>();
  /** Pull requests a merge message is being written for, or that are being merged, right now. */
  private readonly mergeWork = new Set<string>();
  /** Rounds started here that have no record on disk yet, by pull request (see `StartedRound`). */
  private readonly startedRounds = new Map<string, StartedRound>();
  private readonly jobErrors = new Map<string, { message: string; signature: string }>();

  constructor(private readonly deps: WatcherDeps) {
    this.settings = normalizePrWatchSettings(deps.loadSettings());
    this.repoOverrides = normalizeRepoOverridesMap(deps.loadRepoOverrides());
    this.memory = deps.loadMemory();
  }

  /* ---- lifecycle ---- */

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.settings.enabled) this.schedule(FIRST_CHECK_DELAY_MS);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.pokeTimer) clearTimeout(this.pokeTimer);
    this.timer = null;
    this.pokeTimer = null;
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started || !this.settings.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delayMs);
  }

  /**
   * Something that may have changed the picture just happened - typically a run finished, which
   * is when the delivery step registers a new pull request. Checks soon, once, however many
   * runs end at the same time.
   */
  poke(): void {
    if (!this.started || !this.settings.enabled) return;
    if (this.pokeTimer) clearTimeout(this.pokeTimer);
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null;
      void this.refresh();
    }, POKE_DEBOUNCE_MS);
  }

  /* ---- state ---- */

  getState(): PrWatchState {
    return {
      settings: { ...this.settings },
      checking: this.checking,
      lastCheckedAt: this.lastCheckedAt,
      watching: this.views.length,
      pullRequests: this.views.map((view) => ({ ...view })),
      error: this.checkError,
    };
  }

  private publish(): void {
    this.deps.emit(this.getState());
  }

  /**
   * The automatic steps in force for one repository: the defaults, with whatever that repository
   * overrides on top.
   */
  settingsFor(repoPath: string): PrWatchSettings {
    return { ...this.settings, ...(this.repoOverrides[path.basename(repoPath)] ?? {}) };
  }

  getSettings(): PrWatchSettingsBundle {
    return { defaults: { ...this.settings }, repos: structuredClone(this.repoOverrides) };
  }

  /**
   * Saves settings from the Settings screen. `defaults` is merged over the current defaults;
   * `repos`, when given, replaces every repository's overrides (what is not in it is back to
   * "use the default").
   */
  saveSettings(bundle: { defaults?: Partial<PrWatchSettings>; repos?: Record<string, RepoPrWatchOverrides> }): PrWatchSettingsBundle {
    const before = this.settings;

    if (bundle.defaults) {
      this.settings = normalizePrWatchSettings({ ...this.settings, ...bundle.defaults });
      this.deps.saveSettings(this.settings);
    }
    if (bundle.repos) {
      this.repoOverrides = normalizeRepoOverridesMap(bundle.repos);
      this.deps.saveRepoOverrides(this.repoOverrides);
    }

    if (!this.settings.enabled) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    } else if (!before.enabled || before.intervalSeconds !== this.settings.intervalSeconds) {
      // Turned on, or the interval changed: do not make the user wait out the old one.
      this.schedule(before.enabled ? this.settings.intervalSeconds * 1000 : 0);
    }
    // The wording of some statuses depends on the settings; recompute them from what we know.
    this.rebuild();
    return this.getSettings();
  }

  /* ---- checking ---- */

  /**
   * Checks now. Overlapping requests are merged: at most one check runs, plus one queued behind it.
   *
   * What the check finds may start work (see `applyAutomation`). That happens AFTER the check has
   * released its in-flight slot: the actions it takes end by refreshing, and a refresh that had to
   * wait for a check that was itself waiting for that action would never finish.
   */
  async refresh(options: { automate?: boolean } = {}): Promise<void> {
    if (this.inFlight) {
      this.rerunRequested = true;
      return this.inFlight;
    }
    this.inFlight = this.runCheck().finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;

    if (options.automate !== false && !this.checkError && this.settings.enabled) {
      await this.applyAutomation();
    }
    if (this.rerunRequested) {
      this.rerunRequested = false;
      await this.refresh();
    }
  }

  private async runCheck(): Promise<void> {
    this.checking = true;
    this.publish();

    try {
      const result = await this.deps.runCli(['pr-check'], { timeoutMs: CHECK_TIMEOUT_MS });
      const payload = parseMarkerLine<PrCheckResult & { error?: string }>(result.stdout, 'PR_CHECK_JSON');

      if (result.code !== 0 || !payload || payload.error || !Array.isArray(payload.pullRequests)) {
        this.checkError = payload?.error ?? summarizeFailure(result);
        this.deps.log?.(`pr-check failed: ${this.checkError}`);
      } else {
        this.checkError = null;
        this.lastCheck = payload;
        this.lastCheckedAt = payload.checkedAt;
        this.views = this.buildViews(payload);
        this.forgetClosed(payload);
      }
    } catch (error) {
      this.checkError = (error as Error).message;
    } finally {
      this.checking = false;
      this.publish();
      this.schedule(this.settings.intervalSeconds * 1000);
    }
  }

  /** Drops the memory of pull requests that are no longer open. */
  private forgetClosed(check: PrCheckResult): void {
    const open = new Set(check.pullRequests.filter((pr) => pr.state === 'OPEN').map((pr) => pr.key));
    let changed = false;
    for (const table of [this.memory.triageAttempts, this.memory.reviseAttempts, this.memory.approvals]) {
      for (const key of Object.keys(table)) {
        if (!open.has(key)) {
          delete table[key];
          changed = true;
        }
      }
    }
    if (changed) this.deps.saveMemory(this.memory);

    for (const key of this.startedRounds.keys()) {
      if (!open.has(key)) this.startedRounds.delete(key);
    }
  }

  /**
   * The round we started for this pull request that the disk cannot speak for yet, if any. The
   * entry ends as soon as the round has its own record, or when its process is gone without ever
   * having written one - otherwise the card would say "running" about a round that is not.
   */
  private unrecordedRound(key: string, rounds: RoundInfo[]): StartedRound | undefined {
    const started = this.startedRounds.get(key);
    if (!started) return undefined;
    if (rounds.some((round) => round.runId === started.runId) || !this.deps.isRunActive(started.runId)) {
      this.startedRounds.delete(key);
      return undefined;
    }
    return started;
  }

  private buildViews(check: PrCheckResult): WatchedPullRequest[] {
    const views = check.pullRequests
      .filter((pr) => pr.state === 'OPEN')
      .map((pr): WatchedPullRequest => {
        const rounds = this.deps.listRounds(pr.repoPath, pr.number, pr.rootRunId);
        const classification = classifyPullRequest({
          pr,
          inFlightTriage: this.triaging.has(pr.key),
          jobError: this.jobErrors.get(pr.key),
          rounds,
          triage: this.deps.latestTriage(pr.repoPath, pr.number),
          busy: this.deps.findBusyRun(pr.repoPath),
          starting: this.unrecordedRound(pr.key, rounds),
          attemptedRevise: this.memory.reviseAttempts[pr.key],
          settings: this.settingsFor(pr.repoPath),
        });
        return {
          key: pr.key,
          repoPath: pr.repoPath,
          repoName: pr.repoName,
          number: pr.number,
          url: pr.url,
          title: pr.title,
          headBranch: pr.headBranch,
          baseBranch: pr.baseBranch,
          rootRunId: pr.rootRunId,
          latestRunId: pr.latestRunId,
          // The registry only advances when a round delivers; one that ran without pushing (or
          // failed) still counts, or the next round would be given its number again.
          round: Math.max(pr.round, ...rounds.map((round) => round.round)),
          pending: pr.pending,
          status: classification.status,
          message: classification.message,
          merge: mergeStatusOf(pr, this.memory.approvals[pr.key]),
          triage: classification.triage,
          revisionRunId: classification.revisionRunId ?? null,
          retryable: classification.retryable === true,
        };
      });

    return views.sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.number - a.number,
    );
  }

  /** Rebuilds the views from the last check without asking GitHub again. */
  private rebuild(): void {
    if (this.lastCheck) this.views = this.buildViews(this.lastCheck);
    this.publish();
  }

  /* ---- automation: the only place that starts anything by itself ---- */

  private async applyAutomation(): Promise<void> {
    // Work from the keys as they were when the check finished, but read each pull request live:
    // an action taken for one of them refreshes the picture for all of them.
    for (const key of this.views.map((view) => view.key)) {
      const view = this.views.find((candidate) => candidate.key === key);
      if (!view) continue;

      try {
        // Triage: only when something NEW arrived. Old comments are listed, never auto-processed.
        const settings = this.settingsFor(view.repoPath);
        if (
          view.status === 'pending' &&
          settings.autoTriage &&
          view.pending.some((comment) => comment.fresh) &&
          this.memory.triageAttempts[view.key] !== signatureOf(view.pending)
        ) {
          this.triage(view.key).catch((error: Error) =>
            this.deps.log?.(`triage of ${view.key} failed: ${error.message}`),
          );
          continue;
        }

        // Revision: the triage must be current, call for code, and have nothing a human must decide.
        if (
          view.status === 'triaged' &&
          settings.autoRevise &&
          view.triage &&
          REVISION_ACTIONS.has(view.triage.action) &&
          view.triage.blockers.length === 0 &&
          this.memory.reviseAttempts[view.key] !== signatureOf(view.pending)
        ) {
          // Not yet possible (working copy in use, uncommitted changes): not an error, try next time.
          if (this.deps.findBusyRun(view.repoPath) || !(await this.deps.isClean(view.repoPath))) continue;
          await this.revise(view.key, { auto: true }).catch((error: Error) =>
            this.deps.log?.(`automatic round for ${view.key} not started: ${error.message}`),
          );
        }
      } catch (error) {
        this.deps.log?.(`automation for ${view.key} failed: ${(error as Error).message}`);
      }
    }
  }

  /* ---- actions ---- */

  private viewOf(key: string): WatchedPullRequest {
    const view = this.views.find((candidate) => candidate.key === key);
    if (!view) throw new Error('This pull request is no longer being watched.');
    return view;
  }

  /**
   * Classifies the pending comments with the triage agent (read-only).
   *
   * Triages run one at a time: each is a model call, and several pull requests with new comments
   * must not fire several at once.
   */
  async triage(key: string): Promise<void> {
    const view = this.viewOf(key);
    if (this.triaging.has(key)) return;
    if (view.pending.length === 0) throw new Error('There are no unhandled comments to triage.');

    const signature = signatureOf(view.pending);
    this.triaging.add(key);
    this.jobErrors.delete(key);
    this.memory.triageAttempts[key] = signature; // recorded first: a failure must not retry in a loop
    this.deps.saveMemory(this.memory);
    this.rebuild();

    const job = this.triageQueue.then(() => this.runTriage(view, signature));
    this.triageQueue = job; // runTriage never rejects, so the queue never breaks
    await job;

    this.triaging.delete(key);
    // The triage left its result on disk (and, with replies on, changed what is pending): look again.
    // This is also what lets an automatic round follow.
    await this.refresh();
  }

  private async runTriage(view: WatchedPullRequest, signature: string): Promise<void> {
    try {
      const args = ['pr-feedback', '--repo', view.repoPath, '--pr', String(view.number)];
      if (this.settingsFor(view.repoPath).replyOnGitHub) args.push('--post-replies');
      if (this.deps.isDryRun()) args.push('--dry-run');

      const result = await this.deps.runCli(args, { timeoutMs: TRIAGE_TIMEOUT_MS });
      if (result.code !== 0) {
        this.jobErrors.set(view.key, { message: `Triage failed: ${summarizeFailure(result)}`, signature });
      }
    } catch (error) {
      this.jobErrors.set(view.key, { message: `Triage failed: ${(error as Error).message}`, signature });
    }
  }

  /**
   * Starts a round that addresses the pending comments, continuing the original task.
   * Throws for a user-initiated start that cannot proceed; an automatic one records why instead.
   */
  async revise(
    key: string,
    options: { auto?: boolean; task?: string; action?: 'RERUN_IMPLEMENTATION' | 'RERUN_PLANNING' } = {},
  ): Promise<{ runId: string }> {
    const view = this.viewOf(key);

    // Claimed synchronously, before the first await: a double click (or a click racing the
    // automation) must not get past this point twice.
    if (this.starting.has(key)) throw new Error('A round is already being started for this pull request.');
    this.starting.add(key);

    const signature = signatureOf(view.pending);
    const fail = (message: string): never => {
      if (options.auto) this.jobErrors.set(key, { message, signature });
      throw new Error(message);
    };

    try {
      if (view.pending.length === 0) return fail('There are no unhandled comments to address.');
      if (view.status === 'revising' || view.status === 'awaiting-approval') {
        return fail('A round is already in progress for this pull request.');
      }
      // Blocked but not failed: the round is parked at a gate and still uses the working copy.
      if (view.status === 'blocked' && view.revisionRunId && !view.retryable) {
        return fail(`Round ${view.round} is waiting for your input. Open it to continue instead of starting another one.`);
      }

      const triage = this.deps.latestTriage(view.repoPath, view.number);
      if (!triage || !triageCovers(triage, view.pending)) {
        return fail('These comments have not been triaged yet. Triage them first.');
      }

      const busy = this.deps.findBusyRun(view.repoPath);
      if (busy) {
        // A round of this very pull request was dealt with above, so this is always some other run.
        const shared = 'in this repository and uses the same working copy';
        return fail(
          busy.reason === 'running'
            ? `Another run is in progress ${shared}: ${nameOfRun(busy)}. Wait for it to finish, or stop it, then try again.`
            : `Another run is waiting for your input ${shared}: ${nameOfRun(busy)}. Answer it or close it, then try again.`,
        );
      }
      if (!(await this.deps.isClean(view.repoPath))) {
        return fail(
          'The repository has uncommitted changes. Commit or stash them so the factory can start the round on a clean working copy.',
        );
      }

      this.jobErrors.delete(key);
      this.memory.reviseAttempts[key] = signature; // recorded before starting: no automatic second attempt
      this.deps.saveMemory(this.memory);

      try {
        const args = ['revise', '--repo', view.repoPath, '--pr', String(view.number), '--triage-run', triage.runId];
        if (options.action) args.push('--action', options.action);
        // `--task=<text>` rather than `--task <text>`: the parser would take a task that starts
        // with "--" for a flag and drop it.
        if (options.task?.trim()) args.push(`--task=${options.task.trim()}`);
        if (this.settingsFor(view.repoPath).replyOnGitHub) args.push('--reply', 'true');
        if (this.deps.isDryRun()) args.push('--dry-run');

        const started = await this.deps.startRun(args, { userInitiated: !options.auto });
        // Known only to us until the round writes its own record (see `StartedRound`).
        this.startedRounds.set(key, { runId: started.runId, round: view.round + 1 });
        this.deps.log?.(`round ${view.round + 1} of ${key} started as ${started.runId}`);
        return started;
      } catch (error) {
        const message = `Could not start the round: ${(error as Error).message}`;
        this.jobErrors.set(key, { message, signature });
        throw new Error(message);
      }
    } finally {
      this.starting.delete(key);
      // The new round is on disk and nothing about GitHub changed: recompute locally. (A full
      // refresh here would re-enter the automation that may be calling us.)
      this.rebuild();
    }
  }

  /** Sets the pending comments aside: they stop counting and are never acted on. */
  async dismiss(key: string): Promise<void> {
    const view = this.viewOf(key);
    if (view.pending.length === 0) return;
    const result = await this.deps.runCli([
      'pr-dismiss',
      '--repo',
      view.repoPath,
      '--pr',
      String(view.number),
      '--comments',
      view.pending.map((comment) => comment.id).join(','),
    ]);
    if (result.code !== 0) throw new Error(summarizeFailure(result));
    await this.refresh();
  }

  /** Posts the answers the triage drafted for questions and notes. */
  async postReplies(key: string): Promise<void> {
    const view = this.viewOf(key);
    const result = await this.deps.runCli(['pr-reply', '--repo', view.repoPath, '--pr', String(view.number)], {
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    if (result.code !== 0) throw new Error(summarizeFailure(result));
    await this.refresh();
  }

  /* ---- merging ---- */

  /**
   * What has to be true before anything about merging is offered or done. Returns the approval
   * (when `needApproval`), so the caller works with the commit the human actually approved.
   */
  private assertReadyToMerge(view: WatchedPullRequest, needApproval: boolean): Approval | null {
    if (view.status !== 'idle') {
      throw new Error('This pull request still has review comments or a round in progress. Deal with those first.');
    }
    if (view.merge.blockers.length > 0) {
      throw new Error(`It cannot be merged yet: ${view.merge.blockers.join(' ')}`);
    }
    if (!needApproval) return null;
    if (!view.merge.approval) {
      throw new Error(
        view.merge.approvalOutdated
          ? 'The pull request changed after you approved it. Review it again, then approve the new version.'
          : 'Approve the pull request first.',
      );
    }
    return view.merge.approval;
  }

  /**
   * "I reviewed it and I have no comments." `headSha` is the commit the screen showed: if the
   * branch has moved since, the approval is refused - it must never cover code the human has not
   * seen.
   */
  async approve(key: string, headSha: string): Promise<void> {
    const view = this.viewOf(key);
    this.assertReadyToMerge(view, false);
    if (view.merge.headSha === null) {
      throw new Error('GitHub has not reported the latest commit of this pull request yet. Check again in a moment.');
    }
    if (view.merge.headSha !== headSha) {
      throw new Error(
        `The pull request changed: it is now at ${view.merge.headSha.slice(0, 7)}, not ${headSha.slice(0, 7)}. ` +
          'Review it again, then approve.',
      );
    }
    this.memory.approvals[key] = { headSha, approvedAt: new Date(this.deps.now()).toISOString() };
    this.deps.saveMemory(this.memory);
    this.deps.log?.(`${key} approved at ${headSha.slice(0, 7)}`);
    this.rebuild();
  }

  /** Takes the approval back. */
  async withdrawApproval(key: string): Promise<void> {
    this.viewOf(key);
    if (this.memory.approvals[key] === undefined) return;
    delete this.memory.approvals[key];
    this.deps.saveMemory(this.memory);
    this.rebuild();
  }

  /**
   * Has the factory write the commit message the squash would have: an agent reads the final diff
   * (or, failing that, the pull request's own title and summary are used). Changes nothing on
   * GitHub, so it costs at most one small model call.
   */
  async draftMerge(key: string): Promise<PrMergeDraft> {
    const view = this.viewOf(key);
    const approval = this.assertReadyToMerge(view, true)!;
    if (this.mergeWork.has(key)) throw new Error('A merge is already being prepared for this pull request.');
    this.mergeWork.add(key);

    try {
      const args = ['pr-merge-draft', '--repo', view.repoPath, '--pr', String(view.number)];
      if (this.deps.isDryRun()) args.push('--dry-run');
      const result = await this.deps.runCli(args, { timeoutMs: MERGE_DRAFT_TIMEOUT_MS });
      const draft = parseMarkerLine<PrMergeDraft & { error?: string }>(result.stdout, 'PR_MERGE_DRAFT_JSON');
      if (!draft || draft.error) throw new Error(draft?.error ?? summarizeFailure(result));

      // The message describes the pull request as it is NOW. If it moved since the approval, a
      // message for the new code must not be offered against the old approval.
      if (draft.pullRequest.headSha !== approval.headSha) {
        // News: look again now, so the card shows the new commit instead of the picture the user acted on.
        await this.refresh();
        throw new Error('The pull request changed after you approved it. Review it again, then approve the new version.');
      }
      return draft;
    } finally {
      this.mergeWork.delete(key);
    }
  }

  /**
   * Squash-merges the approved pull request. The factory re-checks everything on GitHub just
   * before (not what this window showed a minute ago) and GitHub itself refuses if the branch is
   * no longer at the approved commit.
   */
  async merge(key: string, input: { subject: string; body: string; deleteBranch: boolean }): Promise<PrMergeResult> {
    const view = this.viewOf(key);
    const approval = this.assertReadyToMerge(view, true)!;

    const subject = input.subject.trim();
    if (subject === '') throw new Error('The commit message needs a subject.');
    if (subject.includes('\n')) throw new Error('The subject of the commit message must be a single line.');
    if (input.body.length > MAX_COMMIT_BODY_CHARS) {
      throw new Error(`The description is too long (more than ${MAX_COMMIT_BODY_CHARS.toLocaleString('en-US')} characters).`);
    }
    if (this.mergeWork.has(key)) throw new Error('A merge is already in progress for this pull request.');
    this.mergeWork.add(key);

    try {
      // Putting the user's working copy back on the base branch switches its checkout, which would
      // pull the rug from under a run that is still using it. The merge itself does not need it.
      const returnToBase = this.deps.findBusyRun(view.repoPath) === null;

      // `--flag=value`: a subject or body that starts with "--" must not be taken for a flag.
      const args = [
        'pr-merge',
        '--repo', view.repoPath,
        '--pr', String(view.number),
        '--head-sha', approval.headSha,
        `--subject=${subject}`,
        `--body=${input.body.trim()}`,
        `--delete-branch=${input.deleteBranch}`,
        `--return-to-base=${returnToBase}`,
      ];
      if (this.deps.isDryRun()) args.push('--dry-run');

      const result = await this.deps.runCli(args, { timeoutMs: MERGE_TIMEOUT_MS });
      const outcome = parseMarkerLine<PrMergeResult>(result.stdout, 'PR_MERGE_JSON');
      if (!outcome) throw new Error(summarizeFailure(result));
      if (!outcome.merged && !outcome.dryRun) {
        // Whatever stopped it (the branch moved, a comment arrived, conflicts) is news: look again
        // now, so the card shows the truth instead of waiting for the next poll.
        await this.refresh();
        throw new Error(outcome.reason ?? 'Nothing was merged.');
      }

      if (outcome.merged) {
        // Done with: a merged pull request has nothing left to approve.
        delete this.memory.approvals[key];
        this.deps.saveMemory(this.memory);
        this.deps.log?.(`${key} merged${outcome.mergeCommit ? ` as ${outcome.mergeCommit.slice(0, 7)}` : ''}`);
        await this.refresh();
      }
      return outcome;
    } finally {
      this.mergeWork.delete(key);
    }
  }
}
