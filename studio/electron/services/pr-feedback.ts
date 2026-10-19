/**
 * Reads the result of a pull-request feedback triage from the run directory it left behind.
 *
 * The triage runs as its own process under a throwaway id; the real record is the trace directory
 * the workflow creates (`kind: "pr-feedback"` in its `summary.json`). Kept free of Electron
 * imports so it can be exercised against real directories.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PrFeedbackSummary } from '../../shared/types';
import { readJson } from './run-state.js';

const samePath = (a: string, b: string): boolean => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
};

/**
 * The newest triage result for `prNumber` in `repoPath`, finished at or after `since`.
 * `since` excludes the results of earlier triages of the same pull request.
 */
export function findLatestPrFeedback(
  logsDir: string,
  repoPath: string,
  prNumber: number,
  since?: string,
): PrFeedbackSummary | null {
  if (!fs.existsSync(logsDir)) return null;

  let best: { finishedAt: string; summary: Record<string, unknown> } | null = null;

  for (const entry of fs.readdirSync(logsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const summary = readJson<Record<string, unknown>>(path.join(logsDir, entry.name, 'summary.json'));
    if (!summary || summary.kind !== 'pr-feedback') continue;
    if (Number(summary.pullRequest) !== prNumber) continue;
    if (typeof summary.repository !== 'string' || !samePath(summary.repository, repoPath)) continue;

    const finishedAt = typeof summary.finishedAt === 'string' ? summary.finishedAt : '';
    if (since && finishedAt < since) continue;
    if (!best || finishedAt > best.finishedAt) best = { finishedAt, summary };
  }

  if (!best) return null;
  const s = best.summary;
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

  return {
    runId: String(s.runId ?? ''),
    pullRequest: Number(s.pullRequest),
    pullRequestUrl: String(s.pullRequestUrl ?? ''),
    action: String(s.status ?? 'NO_FEEDBACK') as PrFeedbackSummary['action'],
    summary: String(s.summary ?? ''),
    commentsTriaged: Number(s.commentsTriaged ?? 0),
    repliesPosted: Number(s.repliesPosted ?? 0),
    followUpTask: String(s.followUpTask ?? ''),
    blockers: list(s.blockers),
    headBranch: String(s.branch ?? ''),
    baseBranch: String(s.baseBranch ?? ''),
    items: Array.isArray(s.items) ? (s.items as PrFeedbackSummary['items']) : [],
    commentIds: Array.isArray(s.comments)
      ? (s.comments as Array<{ id?: unknown }>).map((c) => String(c.id))
      : [],
    finishedAt: best.finishedAt || undefined,
  };
}
