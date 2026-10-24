// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ModelChip, ModelsSummary, RoutingPanel } from '../src/components/ModelChip';
import { shortModelName, stepModelBadge, summarizeModels } from '../shared/modelRouting';
import type { ModelRouting, RunArtifact } from '../shared/types';

const FLASH = 'google/gemini-3.1-flash-lite';
const FLASH_5 = 'google/gemini-3.5-flash-lite';

const free = (over: Partial<ModelRouting> = {}): ModelRouting => ({
  requested: FLASH,
  served: FLASH,
  backend: 'free-tier',
  failedOver: false,
  attempts: [{ model: FLASH, backend: 'free-tier', outcome: 'served' }],
  ...over,
});

const quotaFallback = (): ModelRouting => ({
  requested: FLASH,
  served: 'claude-haiku-4-5-20251001',
  backend: 'claude-cli',
  failedOver: true,
  fallbackReason: `${FLASH}: rate-limit`,
  attempts: [
    { model: FLASH, backend: 'free-tier', outcome: 'rate-limit', detail: 'Quota exceeded: 500 per day' },
    { model: FLASH_5, backend: 'free-tier', outcome: 'cooling-down', detail: 'rate-limit until 18:30' },
    { model: 'claude-haiku-4-5-20251001', backend: 'claude-cli', outcome: 'served' },
  ],
});

const artifact = (step: string, model: string | undefined, routing?: ModelRouting): RunArtifact => ({
  step,
  attempt: 1,
  status: 'COMPLETED',
  ...(model ? { model } : {}),
  ...(routing ? { routing } : {}),
  data: {},
});

describe('model names and badges', () => {
  it('shortens provider prefixes and dated Claude ids', () => {
    expect(shortModelName(FLASH)).toBe('gemini-3.1-flash-lite');
    expect(shortModelName('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(shortModelName('claude-cli/haiku')).toBe('haiku');
    expect(shortModelName(undefined)).toBe('');
  });

  it('marks a free-tier step, a Claude step, and a fallback caused by a quota', () => {
    expect(stepModelBadge(artifact('run-namer', FLASH, free()))).toMatchObject({ kind: 'free', fellBack: false, outOfQuota: false });
    expect(stepModelBadge(artifact('developer', 'claude-sonnet-4-6'))).toMatchObject({ kind: 'claude', fellBack: false });
    const badge = stepModelBadge(artifact('run-namer', 'claude-haiku-4-5-20251001', quotaFallback()))!;
    expect(badge).toMatchObject({ kind: 'claude', fellBack: true, outOfQuota: true });
    expect(badge.title).toContain('Asked first: gemini-3.1-flash-lite');
    expect(badge.title).toContain('out of quota');
  });

  it('shows nothing for a step that made no model call or a dry run', () => {
    expect(stepModelBadge(artifact('delivery', undefined))).toBeNull();
    expect(stepModelBadge(artifact('run-namer', 'dry-run-stub'))).toBeNull();
    expect(stepModelBadge(undefined)).toBeNull();
  });

  it('counts the steps per kind and the fallbacks of a run', () => {
    const summary = summarizeModels([
      artifact('run-namer', FLASH, free()),
      artifact('pr-writer', 'claude-haiku-4-5-20251001', quotaFallback()),
      artifact('developer', 'claude-sonnet-4-6'),
    ]);
    expect(summary).toEqual({ free: 1, claude: 2, fellBack: 1, outOfQuota: 1 });
  });
});

describe('model views', () => {
  it('prints the model of a step, and a warning when it fell back', () => {
    const { rerender } = render(<ModelChip artifact={artifact('run-namer', FLASH, free())} />);
    expect(screen.getByTestId('model-chip').textContent).toContain('gemini-3.1-flash-lite');
    expect(screen.getByTestId('model-chip').textContent).toContain('free tier');

    rerender(<ModelChip artifact={artifact('run-namer', 'claude-haiku-4-5-20251001', quotaFallback())} />);
    expect(screen.getByTestId('model-chip').textContent).toContain('⚠');
    expect(screen.getByTestId('model-chip').textContent).toContain('out of quota');
  });

  it('lists every model tried and why each one did not answer', () => {
    render(<RoutingPanel routing={quotaFallback()} />);
    const panel = screen.getByTestId('routing-panel');
    expect(panel.textContent).toContain('claude-haiku-4-5 answered instead of gemini-3.1-flash-lite');
    expect(panel.textContent).toContain('out of quota or rate limited');
    expect(panel.textContent).toContain('Quota exceeded: 500 per day');
    expect(panel.textContent).toContain('skipped: it ran out of quota a moment ago');
  });

  it('says nothing when the first choice answered', () => {
    render(<RoutingPanel routing={free()} />);
    expect(screen.queryByTestId('routing-panel')).toBeNull();
  });

  it('summarises the run in one line', () => {
    render(<ModelsSummary artifacts={[artifact('run-namer', FLASH, free()), artifact('pr-writer', 'claude-haiku-4-5', quotaFallback())]} />);
    const line = screen.getByTestId('models-summary');
    expect(line.textContent).toContain('1 free tier');
    expect(line.textContent).toContain('1 Claude');
    expect(line.textContent).toContain('1 fell back to another model (1 because a model was out of quota)');
  });
});

describe('in a real run', () => {
  it('shows the model under each step of the pipeline, and the fallback', async () => {
    const { RUN } = await import('../../fixtures');
    const { PipelineView } = await import('../src/components/PipelineView');
    const { installFakeApi, openingARun } = await import('./support/fake-api');
    const base = openingARun([RUN.round1]);
    const real = base['factory:get-artifacts'] as (runId: string) => RunArtifact[];
    installFakeApi({
      ...base,
      // The first step answered by a free model that had been out of quota; the rest as recorded.
      'factory:get-artifacts': (runId: string) =>
        real(runId).map((entry, index) =>
          index === 0 ? { ...entry, model: 'claude-haiku-4-5-20251001', routing: quotaFallback() } : entry,
        ),
    });

    render(<PipelineView runId={RUN.round1} isRunning={false} />);

    const summary = await screen.findByTestId('models-summary');
    expect(summary.textContent).toContain('fell back to another model');
    expect(screen.getAllByTestId('model-chip').some((chip) => chip.textContent?.includes('out of quota'))).toBe(true);
  });
});
