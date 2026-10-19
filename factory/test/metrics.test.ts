import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RUNS_DIR, RUN, readJson } from '../../fixtures';
import { aggregateRunMetrics, artifactFileName, generateRunId } from '../src/tools/logger-tools.ts';

describe('aggregateRunMetrics replays the event log of a real run', () => {
  beforeEach(() => {
    vi.stubEnv('FACTORY_LOG_DIR', RUNS_DIR);
  });

  it.each([RUN.round1, RUN.round2])('%s agrees with the summary the run wrote', (runId) => {
    const metrics = aggregateRunMetrics(runId);
    const summary = readJson(runId, 'summary.json');

    expect(metrics.tokens).toEqual(summary.tokens);
    expect(metrics.agentCalls).toBe(summary.agentCalls);
    expect(metrics.toolCalls).toBe(summary.toolCalls);
    expect(metrics.modelsUsed).toEqual(summary.modelsUsed);
    expect(metrics.steps).toEqual(summary.steps);
  });

  it('adds up: what each role used is what the run used', () => {
    const metrics = aggregateRunMetrics(RUN.round1);
    const perRole = metrics.modelsUsed.reduce((sum, entry) => sum + entry.totalTokens, 0);

    expect(perRole).toBe(metrics.tokens.total);
    expect(metrics.agentCalls).toBe(metrics.modelsUsed.reduce((sum, entry) => sum + entry.calls, 0));
  });

  it('keeps both runs of the architect under one role, however many times it was called', () => {
    // Round 1 called the architect twice (before and after the questions were answered).
    const architect = aggregateRunMetrics(RUN.round1).modelsUsed.find((entry) => entry.role === 'pm-architect');
    expect(architect?.calls).toBe(2);
  });

  it('counts nothing for a round that reused the plan', () => {
    expect(aggregateRunMetrics(RUN.round2).modelsUsed.some((entry) => entry.role === 'pm-architect')).toBe(false);
  });
});

describe('trace naming', () => {
  it('names the artifacts of later attempts apart', () => {
    expect(artifactFileName('developer')).toBe('02-developer.json');
    expect(artifactFileName('developer', 2)).toBe('02-developer.attempt-2.json');
    expect(artifactFileName('delivery')).toBe('08-pull-request.json');
  });

  it('makes run ids that sort by time and name the repository', () => {
    const id = generateRunId('Invest Track!');
    expect(id).toMatch(/^\d{8}-\d{6}-invest-track-[a-z0-9]{1,4}$/);
    expect(generateRunId('')).toMatch(/-run-/);
  });
});
