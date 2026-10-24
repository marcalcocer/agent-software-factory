/**
 * The live activity of the agents, shaped for the views.
 *
 * The factory writes one entry per thing an agent call does (`activity.ndjson`, see `ActivityEntry`). Here
 * those entries are matched to the pipeline's steps (by step name and attempt, never by time), grouped by
 * call, and their streamed text pieces joined back into paragraphs.
 */
import { normalizeStep, type PipelineNode } from './pipelineState';
import type { ActivityEntry } from './types';

/** Steps whose pipeline node stands for one attempt (`developer-2`); the others show every attempt. */
const ATTEMPT_SCOPED = new Set(['developer', 'qa-tester', 'triage']);

/** The entries that belong to a pipeline node. */
export function activityForNode(entries: ActivityEntry[], node: Pick<PipelineNode, 'artifactStep' | 'attempt'> | undefined): ActivityEntry[] {
  if (!node?.artifactStep) return [];
  const step = normalizeStep(node.artifactStep);
  return entries.filter(
    (entry) => normalizeStep(entry.step) === step && (!ATTEMPT_SCOPED.has(step) || entry.attempt === node.attempt),
  );
}

export interface ActivityItem {
  kind: ActivityEntry['kind'];
  text: string;
  at: string;
}

export interface ActivityCall {
  call: string;
  role: string;
  step: string;
  attempt: number;
  /** The model asked last (or the one that answered, once it did). */
  model?: string;
  backend?: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  durationMs?: number;
  tokens?: number;
  items: ActivityItem[];
}

/** Groups entries by call, in order, joining the pieces of each streamed paragraph. */
export function groupCalls(entries: ActivityEntry[]): ActivityCall[] {
  const calls = new Map<string, ActivityCall>();
  const lastBlock = new Map<string, string | undefined>();
  for (const entry of entries) {
    let call = calls.get(entry.call);
    if (!call) {
      call = {
        call: entry.call,
        role: entry.role,
        step: entry.step,
        attempt: entry.attempt,
        status: 'running',
        startedAt: entry.at,
        items: [],
      };
      calls.set(entry.call, call);
    }
    if (entry.kind === 'call-start') {
      call.model = entry.model ?? call.model;
      call.backend = entry.backend ?? call.backend;
      call.status = 'running';
    } else if (entry.kind === 'call-end') {
      call.status = 'done';
      call.model = entry.model ?? call.model;
      call.backend = entry.backend ?? call.backend;
      call.durationMs = entry.durationMs;
      call.tokens = entry.tokens;
    } else if (entry.kind === 'call-failed') {
      call.status = 'failed';
      call.durationMs = entry.durationMs ?? call.durationMs;
    }

    const previous = call.items[call.items.length - 1];
    if (entry.kind === 'text' && previous?.kind === 'text' && entry.block && lastBlock.get(entry.call) === entry.block) {
      previous.text += entry.text;
    } else {
      call.items.push({ kind: entry.kind, text: entry.text, at: entry.at });
    }
    lastBlock.set(entry.call, entry.kind === 'text' ? entry.block : undefined);
  }
  return [...calls.values()];
}

/** The last thing a step was doing, in one line: what the "now" banner shows. */
export function currentActivity(entries: ActivityEntry[]): string | null {
  const calls = groupCalls(entries);
  const call = calls[calls.length - 1];
  if (!call) return null;
  for (let i = call.items.length - 1; i >= 0; i -= 1) {
    const item = call.items[i]!;
    if (item.kind === 'call-end' || item.kind === 'call-failed') continue;
    const text = item.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (item.kind === 'text') return text.length > 160 ? `“…${text.slice(-158)}”` : `“${text}”`;
    return text;
  }
  return null;
}

/** "12.3s", "2m 05s". */
export function formatSeconds(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}
