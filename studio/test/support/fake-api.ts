import { vi } from 'vitest';

import { RUN, runDir } from '../../../fixtures';
import { readRunArtifacts, readRunEvents, readRunState } from '../../electron/services/run-state';
import type { FactoryRun, PrWatchState } from '../../shared/types';

type Handler = (...args: any[]) => unknown;

export interface FakeApi {
  /** Calls made through `window.api.invoke`, in order. */
  calls: Array<{ channel: string; args: unknown[] }>;
  callsTo: (channel: string) => unknown[][];
  /** Delivers an event from the main process to whoever listens. */
  emit: (channel: string, ...args: unknown[]) => void;
  /** Replaces what a channel answers. */
  answer: (channel: string, handler: Handler) => void;
}

/**
 * Stands in for the Electron bridge: `window.api.invoke` answers from `handlers`, and `window.api.on`
 * keeps the listeners so a test can send the events the main process would. A channel nobody
 * answered fails loudly - a screen that asks for something the test did not expect is a finding.
 */
export function installFakeApi(handlers: Record<string, Handler> = {}): FakeApi {
  const table = new Map<string, Handler>(Object.entries(handlers));
  const listeners = new Map<string, Set<Handler>>();
  const calls: FakeApi['calls'] = [];

  (window as unknown as { api: unknown }).api = {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      const handler = table.get(channel);
      if (!handler) throw new Error(`The test did not expect the screen to call "${channel}".`);
      return handler(...args);
    }),
    on: (channel: string, callback: Handler) => {
      const set = listeners.get(channel) ?? new Set<Handler>();
      set.add(callback);
      listeners.set(channel, set);
      return () => set.delete(callback);
    },
    once: () => {},
  };

  return {
    calls,
    callsTo: (channel) => calls.filter((call) => call.channel === channel).map((call) => call.args),
    emit: (channel, ...args) => listeners.get(channel)?.forEach((callback) => callback(...args)),
    answer: (channel, handler) => table.set(channel, handler),
  };
}

export const REPO_PATH = '/home/dev/workspace/invest-track';

export const idleWatcher = (): PrWatchState => ({
  settings: { enabled: true, intervalSeconds: 60, autoTriage: true, autoRevise: true, replyOnGitHub: false },
  checking: false,
  lastCheckedAt: null,
  watching: 0,
  pullRequests: [],
  error: null,
});

/** What `factory:list` answers for some of the real runs, as the main process would read them. */
export function listOf(runIds: string[], alive: string[] = []): FactoryRun[] {
  return runIds.map((runId) => readRunState(runDir(runId), runId, alive.includes(runId))!.run);
}

/** The channels a screen asks for when it opens a real run, answered from that run's files. */
export function openingARun(runIds: string[] = [RUN.round1, RUN.round2], alive: string[] = []): Record<string, Handler> {
  return {
    'factory:get': (runId: string) => readRunState(runDir(runId), runId, alive.includes(runId))?.run ?? null,
    'factory:get-artifacts': (runId: string) => readRunArtifacts(runDir(runId)),
    'factory:get-events': (runId: string) => readRunEvents(runDir(runId)),
    'factory:get-pending-input': () => null,
    'factory:get-output': () => ({ lines: [], total: 0 }),
    'factory:get-rounds': (runId: string) => {
      const root = listOf([runId])[0]!.rootRunId ?? runId;
      return listOf(runIds, alive)
        .filter((run) => (run.rootRunId ?? run.runId) === root)
        .map((run) => ({ runId: run.runId, round: run.round ?? 1, status: run.status, startedAt: run.startedAt, kind: run.kind ?? 'run' }));
    },
  };
}

/** The handlers `App` needs to start up signed in, with one repository. */
export function appHandlers(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'auth:status': () => [{ id: 'claude-cli', name: 'Claude CLI', status: 'authenticated' }],
    'settings:get': () => ({
      global: {
        theme: 'light',
        workspaceRoot: '/home/dev/workspace',
        defaultMaxAttempts: 3,
        dryRunByDefault: false,
        logLevel: 'info',
        activeProvider: 'claude-cli',
      },
      repos: {},
    }),
    'factory:list-repos': () => [{ name: 'invest-track', path: REPO_PATH, recentRuns: 2 }],
    'pr-watch:get': () => idleWatcher(),
    ...extra,
  };
}
