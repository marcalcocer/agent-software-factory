/**
 * Run tracing: per-execution trace directories, JSON step artifacts and metric aggregation.
 *
 * Every execution owns a directory `./logs/<runId>/` containing:
 *   run.json                  run metadata (task, repository, branch, configuration)
 *   events.ndjson             append-only event log (agent calls, tool calls, step results)
 *   01-pm-architect.json      structured artifact per agent step
 *   02-developer.json         (`.attempt-N.json` suffix from the second iteration onwards)
 *   03-qa-tester.json
 *   04-triage.json
 *   05-code-review.json
 *   06-security.json
 *   07-documentation.json
 *   08-pull-request.json
 *   context/*.md              packed repository context blocks
 *   summary.json              tokens, duration, tool calls and models used
 */
import fs from 'node:fs';
import path from 'node:path';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { getFactoryConfig } from '../utils/factory-config.ts';

/* -------------------------------------------------------------------------- */
/* Artifact naming                                                             */
/* -------------------------------------------------------------------------- */

export const ARTIFACT_PREFIXES = {
  // The name of the task, decided before anything else. Numbered 00: it comes first, and sorts first.
  'run-namer': '00-run-namer',
  'pm-architect': '01-pm-architect',
  developer: '02-developer',
  'qa-tester': '03-qa-tester',
  triage: '04-triage',
  'code-review': '05-code-review',
  security: '06-security',
  // The one pass that fixes the minor findings of QA, the review and the audit.
  polish: '06-polish',
  documentation: '07-documentation',
  // The commit message and pull-request text. Same stage number as documentation: it runs right
  // after it (so it can say what was documented) and sorts right after it.
  'pr-writer': '07-pr-writer',
  delivery: '08-pull-request',
  escalation: '09-escalation',
  // Pull-request feedback runs: a separate trace directory, numbered after the main pipeline.
  'feedback-triage': '10-feedback-triage',
  'feedback-delivery': '11-feedback-delivery',
  // The draft of a squash-merge commit message (written when the user is about to merge).
  'merge-summary': '12-merge-summary',
  // What the roadmap looks like after a phase was merged.
  'phase-reconcile': '13-phase-reconcile',
} as const;

export type ArtifactStep = keyof typeof ARTIFACT_PREFIXES;

export function artifactFileName(step: ArtifactStep, attempt = 1): string {
  const prefix = ARTIFACT_PREFIXES[step];
  return attempt > 1 ? `${prefix}.attempt-${attempt}.json` : `${prefix}.json`;
}

/* -------------------------------------------------------------------------- */
/* Trace directories                                                           */
/* -------------------------------------------------------------------------- */

/** Generates a sortable, human-readable run id: `20251008-234512-invest-track-a1b2`. */
export function generateRunId(repoName = 'run'): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const slug =
    repoName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'run';
  const random = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${slug}-${random}`;
}

export function traceDirFor(runId: string): string {
  return path.join(getFactoryConfig().logDir, runId);
}

export interface RunTraceMeta {
  runId: string;
  task: string;
  repoPath: string;
  repoName: string;
  branch?: string;
  baseBranch?: string;
  models?: Record<string, string>;
  /**
   * Which optional stages this run executes (`qa`, `review`, `security`, `documentation`).
   * Persisted so a UI that re-opens the run later shows the stages it really used rather than
   * whatever the task form currently has selected.
   */
  pipeline?: Record<string, boolean>;
  /** `f0042`: one id for the task and all of its rounds (see `utils/task-ids.ts`). */
  taskId?: string;
  /** What the task is called in the run history. Editable by the user. */
  title?: string;
  /** Who chose the title: the namer agent, the plain stand-in, a round's triage, or the user. */
  titleSource?: 'agent' | 'fallback' | 'round' | 'phase' | 'user';
  /** The initiative and phase this run works on (see `initiatives/store.ts`). */
  initiativeId?: string;
  phaseId?: string;
  /** The user's own repository when the work happens in a checkout of its own (`repoPath` stays the user's). */
  workPath?: string;
  isolation?: 'worktree' | 'in-place';
  /**
   * How this run relates to others. Every run is round 1 of its own chain unless it is a
   * revision of a pull request, in which case it points at the run it continues. Persisted so a
   * UI can group the rounds of one task without opening each run.
   */
  kind?: 'run' | 'revision' | 'pr-feedback';
  parentRunId?: string;
  rootRunId?: string;
  round?: number;
  pullRequest?: { number: number; url: string; headBranch: string; baseBranch: string };
  dryRun: boolean;
  startedAt: string;
}

/** Creates `logs/<runId>/` (plus `context/`) and writes `run.json`. */
export function createRunTrace(meta: RunTraceMeta): { runId: string; traceDir: string } {
  const traceDir = traceDirFor(meta.runId);
  fs.mkdirSync(path.join(traceDir, 'context'), { recursive: true });
  fs.writeFileSync(path.join(traceDir, 'run.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  appendEvent(meta.runId, { type: 'run_started', runId: meta.runId, repo: meta.repoPath });
  return { runId: meta.runId, traceDir };
}

/**
 * Opens the trace of a run that may already have a record.
 *
 * The CLI writes `run.json` the moment it starts a run, before the workflow's first step: a UI that
 * is told the run's id must find the run, and the first step used to be the only place that wrote it
 * (a round started in the background was missing from the history for a minute). The first step then
 * completes that record instead of replacing it - the run began when the CLI started it, and the
 * `run_started` event is already in the log.
 */
export function openRunTrace(meta: RunTraceMeta): { runId: string; traceDir: string; startedAt: string } {
  const file = path.join(traceDirFor(meta.runId), 'run.json');
  let existing: Partial<RunTraceMeta> | null = null;
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RunTraceMeta>;
  } catch {
    // No record yet: this is the first writer.
  }
  if (!existing) {
    createRunTrace(meta);
    return { runId: meta.runId, traceDir: traceDirFor(meta.runId), startedAt: meta.startedAt };
  }

  const startedAt = existing.startedAt ?? meta.startedAt;
  const traceDir = ensureRunTrace(meta.runId);
  // A name the user already gave (the run is listed from the moment it is recorded) is theirs to keep.
  const named = existing.titleSource === 'user' ? { title: existing.title, titleSource: existing.titleSource } : {};
  fs.writeFileSync(file, `${JSON.stringify({ ...existing, ...meta, ...named, startedAt }, null, 2)}\n`, 'utf8');
  return { runId: meta.runId, traceDir, startedAt };
}

/** Ensures the trace directory exists (idempotent). */
export function ensureRunTrace(runId: string): string {
  const traceDir = traceDirFor(runId);
  fs.mkdirSync(path.join(traceDir, 'context'), { recursive: true });
  return traceDir;
}

/* -------------------------------------------------------------------------- */
/* Artifacts                                                                   */
/* -------------------------------------------------------------------------- */

export interface WriteArtifactInput {
  runId: string;
  step: ArtifactStep;
  attempt?: number;
  status: string;
  durationMs?: number;
  model?: string;
  data: unknown;
}

/** Writes a step artifact as pretty JSON and returns its absolute path. */
export function writeArtifact(input: WriteArtifactInput): string {
  const traceDir = ensureRunTrace(input.runId);
  const attempt = input.attempt ?? 1;
  const filePath = path.join(traceDir, artifactFileName(input.step, attempt));
  const payload = {
    step: input.step,
    attempt,
    status: input.status,
    model: input.model ?? null,
    durationMs: input.durationMs ?? null,
    writtenAt: new Date().toISOString(),
    data: input.data,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  appendEvent(input.runId, {
    type: 'step_artifact',
    step: input.step,
    attempt,
    status: input.status,
    durationMs: input.durationMs ?? null,
    artifact: path.basename(filePath),
  });
  return filePath;
}

/** Writes a free-form context block (packed repository, diff, raw logs) under `context/`. */
export function writeContextBlock(runId: string, name: string, content: string): string {
  const traceDir = ensureRunTrace(runId);
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(traceDir, 'context', safeName);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/** Lists the artifact files of a run. */
export function listArtifacts(runId: string): string[] {
  const traceDir = traceDirFor(runId);
  if (!fs.existsSync(traceDir)) return [];
  return fs
    .readdirSync(traceDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
}

/** Reads one artifact file of a run (by file name). */
export function readArtifact(runId: string, fileName: string): unknown | null {
  const filePath = path.join(traceDirFor(runId), path.basename(fileName));
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Event log                                                                   */
/* -------------------------------------------------------------------------- */

export interface AgentCallEvent {
  type: 'agent_call';
  role: string;
  step: string;
  attempt: number;
  requestedModel: string;
  servedByModel: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  toolCalls: number;
  durationMs: number;
  failedOver: boolean;
  dryRun: boolean;
}

export type RunEvent = (AgentCallEvent | Record<string, unknown>) & { type: string };

/** Appends one JSON line to `events.ndjson`. Never throws: tracing must not break a run. */
export function appendEvent(runId: string, event: RunEvent): void {
  try {
    const traceDir = ensureRunTrace(runId);
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    fs.appendFileSync(path.join(traceDir, 'events.ndjson'), `${line}\n`, 'utf8');
  } catch {
    // Tracing is best-effort by design.
  }
}

/** Reads back the event log of a run. */
export function readEvents(runId: string): RunEvent[] {
  const filePath = path.join(traceDirFor(runId), 'events.ndjson');
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RunEvent];
      } catch {
        return [];
      }
    });
}

/* -------------------------------------------------------------------------- */
/* Metrics aggregation                                                         */
/* -------------------------------------------------------------------------- */

export interface AggregatedMetrics {
  tokens: { input: number; output: number; reasoning: number; cached: number; total: number };
  agentCalls: number;
  toolCalls: number;
  modelsUsed: {
    role: string;
    requestedModel: string;
    servedByModel: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    durationMs: number;
    failovers: number;
  }[];
  steps: {
    step: string;
    attempt: number;
    status: string;
    durationMs: number;
    artifact: string | null;
  }[];
}

/** Aggregates tokens, tool calls, models and step timings from the run event log. */
export function aggregateRunMetrics(runId: string): AggregatedMetrics {
  const events = readEvents(runId);
  const tokens = { input: 0, output: 0, reasoning: 0, cached: 0, total: 0 };
  const models = new Map<string, AggregatedMetrics['modelsUsed'][number]>();
  const steps: AggregatedMetrics['steps'] = [];
  let agentCalls = 0;
  let toolCalls = 0;

  for (const event of events) {
    if (event.type === 'agent_call') {
      const call = event as AgentCallEvent;
      agentCalls += 1;
      toolCalls += call.toolCalls ?? 0;
      tokens.input += call.inputTokens ?? 0;
      tokens.output += call.outputTokens ?? 0;
      tokens.reasoning += call.reasoningTokens ?? 0;
      tokens.cached += call.cachedTokens ?? 0;
      tokens.total += call.totalTokens ?? 0;

      const key = `${call.role}::${call.servedByModel}`;
      const entry = models.get(key) ?? {
        role: call.role,
        requestedModel: call.requestedModel,
        servedByModel: call.servedByModel,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs: 0,
        failovers: 0,
      };
      entry.calls += 1;
      entry.inputTokens += call.inputTokens ?? 0;
      entry.outputTokens += call.outputTokens ?? 0;
      entry.totalTokens += call.totalTokens ?? 0;
      entry.durationMs += call.durationMs ?? 0;
      entry.failovers += call.failedOver ? 1 : 0;
      models.set(key, entry);
      continue;
    }

    if (event.type === 'step_artifact') {
      steps.push({
        step: String(event.step ?? 'unknown'),
        attempt: Number(event.attempt ?? 1),
        status: String(event.status ?? 'unknown'),
        durationMs: Number(event.durationMs ?? 0),
        artifact: (event.artifact as string | undefined) ?? null,
      });
      continue;
    }

    if (event.type === 'tool_call') toolCalls += 1;
  }

  return { tokens, agentCalls, toolCalls, modelsUsed: [...models.values()], steps };
}

/** Writes `summary.json` for a run and returns its path. */
export function writeSummary(runId: string, summary: unknown): string {
  const traceDir = ensureRunTrace(runId);
  const filePath = path.join(traceDir, 'summary.json');
  fs.writeFileSync(filePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  appendEvent(runId, { type: 'run_finished', summary: 'summary.json' });
  return filePath;
}

/**
 * Writes `pending-input.json`: the open human-in-the-loop request for a suspended run.
 *
 * The workflow snapshot lives inside Mastra's store, which the UI cannot read directly, so the
 * suspend payload is mirrored to the trace directory. The UI polls for this file to decide
 * whether to render an input gate, and the file is removed once the run is resumed.
 */
export function writePendingInput(runId: string, payload: unknown): string {
  const traceDir = ensureRunTrace(runId);
  const filePath = path.join(traceDir, 'pending-input.json');
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

/** Removes `pending-input.json` once the human answered and the run resumed. */
export function clearPendingInput(runId: string): void {
  const filePath = path.join(traceDirFor(runId), 'pending-input.json');
  if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
}

/** Lists known run ids, newest first. */
export function listRuns(): string[] {
  const { logDir } = getFactoryConfig();
  if (!fs.existsSync(logDir)) return [];
  return fs
    .readdirSync(logDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

/* -------------------------------------------------------------------------- */
/* Agent-facing tools                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Lets the Triage agent read the artifacts of previous steps and attempts, which is what
 * enables real root-cause analysis (comparing attempt N with attempt N-1) instead of
 * blind retry counting.
 */
export const readRunArtifactsTool = createTool({
  id: 'read-run-artifacts',
  description:
    'Read the JSON trace artifacts of the current run (plans, developer reports, QA reports, ' +
    'previous triage decisions). Call without `fileName` to list the available artifacts.',
  inputSchema: z.object({
    runId: z.string().describe('The run id given in your task context.'),
    fileName: z
      .string()
      .optional()
      .describe('Artifact file name, e.g. "03-qa-tester.attempt-2.json". Omit to list them.'),
  }),
  outputSchema: z.object({
    available: z.array(z.string()),
    fileName: z.string().nullable(),
    content: z.unknown().nullable(),
  }),
  execute: async ({ runId, fileName }) => {
    const available = listArtifacts(runId);
    if (!fileName) return { available, fileName: null, content: null };
    return { available, fileName, content: readArtifact(runId, fileName) };
  },
});

/** Lets an agent record a structured note in the run event log. */
export const logEventTool = createTool({
  id: 'log-event',
  description:
    'Append a structured note to the run trace (events.ndjson). Use it to record a decision, ' +
    'an observation or a deviation that downstream agents and humans should see.',
  inputSchema: z.object({
    runId: z.string(),
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
  outputSchema: z.object({ recorded: z.boolean() }),
  execute: async ({ runId, level, message, details }) => {
    appendEvent(runId, { type: 'agent_note', level, message, details: details ?? {} });
    return { recorded: true };
  },
});

export const loggerTools = {
  readRunArtifactsTool,
  logEventTool,
};

/**
 * Merges `patch` into a run's `run.json`. Best effort, like the rest of the tracing: it keeps
 * the Studio's view of the run (for instance the branch name after a rename) accurate.
 */
export function updateRunMeta(runId: string, patch: Partial<RunTraceMeta>): void {
  try {
    const file = path.join(traceDirFor(runId), 'run.json');
    if (!fs.existsSync(file)) return;
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as RunTraceMeta;
    // The user's own name for a run is never replaced by one the factory chose, except by the user.
    const keepName = current.titleSource === 'user' && patch.titleSource !== 'user';
    const { title: _title, titleSource: _titleSource, ...rest } = patch;
    fs.writeFileSync(file, `${JSON.stringify({ ...current, ...(keepName ? rest : patch) }, null, 2)}\n`, 'utf8');
  } catch {
    // Tracing is best-effort by design.
  }
}
