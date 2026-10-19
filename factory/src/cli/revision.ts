/**
 * Turns "this pull request has review comments, and the triage says what to do" into a *round*:
 * the input of a further run that continues the original task.
 *
 * Kept free of the CLI's side effects so the rules - which round is next, which run it continues,
 * which plan it starts from - can be tested on their own.
 */
import fs from 'node:fs';
import path from 'node:path';

import { getFactoryConfig } from '../utils/factory-config.ts';
import { loadRegistry, pullRequestKey, type RegisteredPullRequest } from '../tools/pr-registry.ts';
import type { PipelineConfig, Revision, RevisionComment } from '../utils/schemas.ts';

/** What the triage wrote to its `summary.json` (the parts a round needs). */
export interface TriageSummary {
  runId: string;
  pullRequest: number;
  repository: string;
  status: string;
  summary: string;
  followUpTask: string;
  blockers: string[];
  branch: string;
  baseBranch?: string;
  comments: RevisionComment[];
  finishedAt?: string;
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

const logDir = (): string => getFactoryConfig().logDir;

export function readTriageSummary(runId: string): TriageSummary | null {
  const summary = readJson<Record<string, unknown>>(path.join(logDir(), runId, 'summary.json'));
  if (!summary || summary.kind !== 'pr-feedback') return null;
  return {
    runId,
    pullRequest: Number(summary.pullRequest),
    repository: String(summary.repository ?? ''),
    status: String(summary.status ?? ''),
    summary: String(summary.summary ?? ''),
    followUpTask: String(summary.followUpTask ?? ''),
    blockers: Array.isArray(summary.blockers) ? summary.blockers.map(String) : [],
    branch: String(summary.branch ?? ''),
    ...(typeof summary.baseBranch === 'string' ? { baseBranch: summary.baseBranch } : {}),
    comments: Array.isArray(summary.comments) ? (summary.comments as RevisionComment[]) : [],
    ...(typeof summary.finishedAt === 'string' ? { finishedAt: summary.finishedAt } : {}),
  };
}

/** The newest triage of this pull request, or `null`. */
export function findLatestTriage(repoPath: string, number: number): TriageSummary | null {
  const dir = logDir();
  if (!fs.existsSync(dir)) return null;
  let best: TriageSummary | null = null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const triage = readTriageSummary(entry.name);
    if (!triage || triage.pullRequest !== number) continue;
    if (path.resolve(triage.repository) !== path.resolve(repoPath)) continue;
    if (!best || (triage.finishedAt ?? '') > (best.finishedAt ?? '')) best = triage;
  }
  return best;
}

export function lookupPullRequest(repoPath: string, number: number): RegisteredPullRequest | null {
  return loadRegistry().pullRequests[pullRequestKey(repoPath, number)] ?? null;
}

/** What a run's `run.json` says about it (the parts the revision logic needs). */
export interface RunMeta {
  task?: string;
  pipeline?: Partial<PipelineConfig>;
  kind?: string;
  rootRunId?: string;
  parentRunId?: string;
  round?: number;
}

export function readRunMeta(runId: string): RunMeta | null {
  return readJson(path.join(logDir(), runId, 'run.json'));
}

/**
 * The most recent run of a task - the original run or its latest round - whatever became of it.
 *
 * The pull-request registry only moves forward when a round *delivers*. A round that finished
 * without pushing (the human kept it local) or failed leaves the registry behind, and numbering
 * the next round from it would reuse that round's number and continue from the wrong run. The
 * work, though, is on the shared branch: the next round has to follow the latest run.
 */
export function latestRunInChain(rootRunId: string): { runId: string; round: number } {
  let tip = { runId: rootRunId, round: 1 };
  const dir = logDir();
  if (!fs.existsSync(dir)) return tip;

  // Run ids start with a timestamp: a round is always created after the run it continues.
  for (const name of fs.readdirSync(dir)) {
    if (name <= rootRunId) continue;
    const meta = readRunMeta(name);
    if (!meta || meta.kind === 'pr-feedback' || (meta.rootRunId ?? name) !== rootRunId) continue;
    const round = meta.round ?? 1;
    if (round > tip.round || (round === tip.round && name > tip.runId)) tip = { runId: name, round };
  }
  return tip;
}

export type RevisionAction = Revision['action'];

export function isRevisionAction(value: string): value is RevisionAction {
  return value === 'RERUN_IMPLEMENTATION' || value === 'RERUN_PLANNING';
}

export interface ComposeInput {
  entry: RegisteredPullRequest;
  triage: TriageSummary;
  /** Overrides what the triage recommended (the human decided otherwise). */
  action?: RevisionAction;
  replyOnGitHub?: boolean;
}

export type ComposeResult =
  | { ok: true; revision: Revision; task: string; pipeline: Partial<PipelineConfig> | undefined }
  | { ok: false; reason: string };

/**
 * Builds the round that follows `entry.latestRunId`.
 *
 * It continues from the *latest* run on the pull request (the previous round), keeps the root of
 * the chain, and carries the original task so every agent still knows what the PR is about.
 */
export function composeRevision(input: ComposeInput): ComposeResult {
  const { entry, triage } = input;

  const action = input.action ?? (isRevisionAction(triage.status) ? triage.status : null);
  if (!action) {
    return {
      ok: false,
      reason:
        `The triage of pull request #${entry.number} concluded "${triage.status}", which does not ` +
        'call for code changes. Pass an explicit action to override that.',
    };
  }
  // Comments dealt with since the triage (dismissed, or answered) are not part of the round.
  const handled = new Set(entry.handledCommentIds);
  const comments = triage.comments.filter((comment) => !handled.has(comment.id));
  if (comments.length === 0) {
    return { ok: false, reason: 'Every review comment of this triage has already been handled.' };
  }

  const root = readRunMeta(entry.rootRunId);
  const tip = latestRunInChain(entry.rootRunId);
  const parent = readRunMeta(tip.runId);
  const task = triage.followUpTask.trim();

  return {
    ok: true,
    task: task || `Address the review comments on pull request #${entry.number}.`,
    pipeline: parent?.pipeline ?? root?.pipeline,
    revision: {
      parentRunId: tip.runId,
      rootRunId: entry.rootRunId,
      round: Math.max(entry.round, tip.round) + 1,
      action,
      originalTask: root?.task ?? parent?.task ?? '',
      pullRequest: {
        number: entry.number,
        url: entry.url,
        title: entry.title,
        headBranch: entry.headBranch,
        baseBranch: entry.baseBranch,
      },
      comments,
      ...(input.replyOnGitHub ? { replyOnGitHub: true } : {}),
    },
  };
}
