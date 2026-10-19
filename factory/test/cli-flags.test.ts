import { describe, expect, it } from 'vitest';

import { followUpRunFlags } from '../src/cli/pr-feedback-followup.ts';
import { parsePipelineFlags } from '../src/cli/pipeline-flags.ts';

describe('parsePipelineFlags', () => {
  it('runs everything when nothing is switched off', () => {
    expect(parsePipelineFlags({})).toBeUndefined();
    expect(parsePipelineFlags({ repo: 'x', task: 'y' })).toBeUndefined();
  });

  it('switches off what --no-<stage> names', () => {
    expect(parsePipelineFlags({ qa: false, docs: false })).toEqual({ qa: false, documentation: false });
    expect(parsePipelineFlags({ review: false, security: false })).toEqual({ review: false, security: false });
  });

  it('honours --no-<stage> followed by a bare word, which the argument parser stores as a value', () => {
    // `--no-qa foo` becomes flags['no-qa'] = 'foo' instead of qa === false.
    expect(parsePipelineFlags({ 'no-qa': 'foo' })).toEqual({ qa: false });
    expect(parsePipelineFlags({ 'no-docs': 'x', 'no-review': true })).toEqual({ documentation: false, review: false });
  });

  it('honours the explicit forms --qa=false and --docs no', () => {
    expect(parsePipelineFlags({ qa: 'false' })).toEqual({ qa: false });
    expect(parsePipelineFlags({ documentation: 'no' })).toEqual({ documentation: false });
    expect(parsePipelineFlags({ qa: 'true', docs: '1' })).toBeUndefined();
  });
});

describe('followUpRunFlags', () => {
  it('always continues on the pull request branch, whatever the caller passed', () => {
    const flags = followUpRunFlags(
      { repo: 'r', branch: 'somewhere-else', 'base-branch': 'dev', 'max-attempts': '4' },
      { followUpTask: 'Fix it.', headBranch: 'factory/f1/fix', baseBranch: 'master' },
    );

    expect(flags).toEqual({
      repo: 'r',
      'max-attempts': '4',
      task: 'Fix it.',
      branch: 'factory/f1/fix',
      'base-branch': 'master',
    });
  });
});
