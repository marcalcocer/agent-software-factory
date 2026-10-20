import { describe, expect, it } from 'vitest';

import { effectiveIsolation, pipelineArgs, runPhaseArgs, runTaskArgs } from '../electron/services/run-args';

describe('effectiveIsolation', () => {
  it('is what the task form asked for, else the default in Settings, else a checkout of its own', () => {
    expect(effectiveIsolation('in-place', { isolation: 'worktree' })).toBe('in-place');
    expect(effectiveIsolation(undefined, { isolation: 'in-place' })).toBe('in-place');
    expect(effectiveIsolation(undefined, {})).toBe('worktree');
  });
});

describe('pipelineArgs', () => {
  it('names only the stages that were switched off', () => {
    expect(pipelineArgs({ qa: false, review: true, security: false, documentation: false, polish: false })).toEqual(['--no-qa', '--no-security', '--no-docs', '--no-polish']);
    expect(pipelineArgs({ qa: true })).toEqual([]);
    expect(pipelineArgs(undefined)).toEqual([]);
  });
});

describe('runTaskArgs', () => {
  it('turns what the form says into the flags of `run`', () => {
    expect(runTaskArgs({ repo: 'invest-track', task: 'Add pagination', isolation: 'worktree', phasing: 'on', maxAttempts: 4, dryRun: true, pipeline: { review: false } })).toEqual([
      'run', '--repo', 'invest-track', '--task=Add pagination', '--isolation', 'worktree', '--phasing', 'on', '--max-attempts', '4', '--dry-run', '--no-review',
    ]);
  });

  it('always says where the task works, so the factory does not guess from its own environment', () => {
    expect(runTaskArgs({ repo: 'r', task: 't', isolation: 'in-place' })).toEqual(['run', '--repo', 'r', '--task=t', '--isolation', 'in-place']);
  });

  it('passes a task that starts with dashes as the task, not as a flag', () => {
    expect(runTaskArgs({ repo: 'r', task: '--fix the parser', isolation: 'worktree' })).toContain('--task=--fix the parser');
  });
});

describe('runPhaseArgs', () => {
  it('runs a phase of a roadmap in its repository', () => {
    expect(runPhaseArgs({ repoPath: '/w/invest-track', phaseId: 'i0001-p2', isolation: 'worktree', maxAttempts: 3 })).toEqual([
      'run', '--phase', 'i0001-p2', '--repo', '/w/invest-track', '--isolation', 'worktree', '--max-attempts', '3',
    ]);
  });

  it('adds the user\'s notes for this run, trimmed, and leaves them out when empty', () => {
    expect(runPhaseArgs({ repoPath: '/w/r', phaseId: 'p', isolation: 'worktree', notes: '  Keep the old URLs.  ' })).toContain('--task=Keep the old URLs.');
    expect(runPhaseArgs({ repoPath: '/w/r', phaseId: 'p', isolation: 'worktree', notes: '   ' }).some((arg) => arg.startsWith('--task'))).toBe(false);
  });
});
