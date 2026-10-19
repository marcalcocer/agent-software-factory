/**
 * Real run directories, copied from the factory's logs, for tests that replay them.
 *
 * Only what a reader of a run needs is kept: `run.json`, `summary.json`, `events.ndjson` and the
 * numbered step artifacts. Patches, console output and packed context are left out, and the home
 * directory in paths is normalised to `/home/dev`.
 *
 * Why real ones: the code that reads a run (the Studio's run state and pipeline view, the metrics,
 * the plan reuse of a further round) is only ever exercised by whatever the factory actually wrote.
 * A schema or a format change that stops an old run from being read shows up here, not in front of
 * the user.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runs');

/** The runs, by what they are good for. */
export const RUN = {
  /**
   * Round 1 of the UI refactor of invest-track. The architect asked questions and was answered, QA
   * failed once (a privacy leak), triage sent it back, attempt 2 passed, a human approved the
   * delivery with edits, and pull request #8 was opened.
   */
  round1: '20261019-171016-invest-track-61e6',
  /** Round 2 of the same task: a revision after review comments. Reuses the plan, QA failed once. */
  round2: '20261019-173458-invest-track-c0u4',
  /** The triage of the review comments that started round 2 (a run of its own, kind `pr-feedback`). */
  prTriage: '0d4d4bc8-3da0-4da9-b444-263c6e228636',
  /** The squash-merge message draft: a directory with an artifact and events, but no run record. */
  mergeSummary: '20261019-174918-invest-track-merge-8-7hy9',
  /** A plain run that went through in one attempt (dry run). */
  smokeHappy: '20261014-182545-smoke-happy-hby1',
  /** A dry run where the review asked for changes and attempt 2 fixed them. */
  smokeReviewChanges: '20261014-182546-smoke-review-changes-tz77',
  /** A dry run that was escalated to a human and closed by their decision. */
  smokeEscalated: '20261014-182546-smoke-escalate-t8fb',
  /** A run rejected at the door: the task was too short. */
  failedValidation: '20261014-test-validation-err',
} as const;

export const runDir = (runId: string): string => path.join(RUNS_DIR, runId);

export function readJson<T = any>(runId: string, file: string): T {
  return JSON.parse(fs.readFileSync(path.join(runDir(runId), file), 'utf8')) as T;
}

export function readEvents(runId: string): Array<Record<string, any>> {
  return fs
    .readFileSync(path.join(runDir(runId), 'events.ndjson'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** File names of the numbered step artifacts of a run, in order. */
export function artifactFiles(runId: string): string[] {
  return fs
    .readdirSync(runDir(runId))
    .filter((file) => /^\d{2}-.*\.json$/.test(file))
    .sort();
}

/**
 * A scratch copy of some runs, for tests that change what is on disk (cut a run short, add a
 * pending input). `keep` selects the files copied; by default everything.
 */
export function copyRuns(
  into: string,
  runIds: string[],
  keep: (file: string) => boolean = () => true,
): string {
  for (const runId of runIds) {
    const target = path.join(into, runId);
    fs.mkdirSync(target, { recursive: true });
    for (const file of fs.readdirSync(runDir(runId))) {
      if (keep(file)) fs.copyFileSync(path.join(runDir(runId), file), path.join(target, file));
    }
  }
  return into;
}
