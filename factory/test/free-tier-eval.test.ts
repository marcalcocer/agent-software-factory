import { describe, expect, it } from 'vitest';

import {
  buildEvalCases,
  classifyError,
  qualityIssues,
  renderTable,
  summarize,
  type EvalResult,
} from '../src/utils/free-tier-eval.ts';

describe('free-tier evaluation', () => {
  it('has samples for the three roles, each with a prompt and a schema', () => {
    const cases = buildEvalCases();
    expect(new Set(cases.map((c) => c.role))).toEqual(new Set(['run-namer', 'merge-summary', 'pr-writer']));
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const sample of cases) expect(sample.prompt.length).toBeGreaterThan(40);
  });

  it('flags the house rules a valid answer breaks', () => {
    expect(qualityIssues('run-namer', { title: 'Dark mode for every screen', slug: 'dark-mode-every-screen', type: 'feat' })).toEqual([]);
    expect(qualityIssues('run-namer', { title: 'Dark mode.', slug: 'Dark_Mode', type: 'feat' })).toHaveLength(2);
    expect(qualityIssues('merge-summary', { subject: 'Expire cache entries after a minute (#12)', body: '' })).toEqual([
      'subject holds a pull-request reference',
    ]);
    expect(
      qualityIssues('pr-writer', {
        commitMessage: { subject: `${'a'.repeat(80)}.`, body: '' },
        pullRequest: { title: 'ok', body: '## Summary\nx' },
      }),
    ).toEqual(['commit subject over 72 characters', 'commit subject ends with a full stop']);
  });

  it('sorts errors into rate limit, key problem, bad output and the rest', () => {
    expect(classifyError('429 RESOURCE_EXHAUSTED: quota exceeded')).toBe('rate-limit');
    expect(classifyError('403 API key not valid')).toBe('auth');
    expect(classifyError('Agent returned no structured output')).toBe('invalid');
    expect(classifyError('socket hang up')).toBe('error');
  });

  it('summarises per model and role and renders a table', () => {
    const base = { model: 'google/x', role: 'run-namer' as const, caseId: 'n', issues: [] as string[], durationMs: 1000 };
    const results: EvalResult[] = [
      { ...base, outcome: 'ok' },
      { ...base, outcome: 'ok', issues: ['slug is not 3-5 lowercase words'], durationMs: 3000 },
      { ...base, outcome: 'rate-limit' },
    ];
    const rows = summarize(results);
    expect(rows).toEqual([
      { model: 'google/x', role: 'run-namer', runs: 3, valid: 2, clean: 1, rateLimited: 1, failed: 0, avgMs: 1667 },
    ]);
    expect(renderTable(rows)).toContain('2/3');
  });
});
