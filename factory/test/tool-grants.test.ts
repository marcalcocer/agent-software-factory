import { describe, expect, it } from 'vitest';

import { executionEnvironmentNote } from '../src/utils/agent-runner.ts';
import { buildClaudeCliArgs, type ClaudeCliRequest } from '../src/utils/claude-cli.ts';

const request = (over: Partial<ClaudeCliRequest> = {}): ClaudeCliRequest => ({
  systemPrompt: 'You are an agent.',
  prompt: 'Do it.',
  model: 'sonnet',
  cwd: '/repo',
  ...over,
});

/** The values that follow `flag` up to the next flag. */
const valuesOf = (args: string[], flag: string): string[] => {
  const start = args.indexOf(flag);
  if (start === -1) return [];
  const values: string[] = [];
  for (const arg of args.slice(start + 1)) {
    if (arg.startsWith('--')) break;
    values.push(arg);
  }
  return values;
};

describe('what each policy lets an agent do', () => {
  it('lets a read-only role read the repository and the run\'s trace directory, and write nothing', () => {
    const args = buildClaudeCliArgs(request({ toolPolicy: 'read-only', readDirs: ['/logs/run-1'] }));

    expect(valuesOf(args, '--add-dir')).toEqual(['/repo', '/logs/run-1']);
    expect(valuesOf(args, '--allowed-tools')).toEqual(['Read', 'Glob', 'Grep']);
    const denied = valuesOf(args, '--disallowed-tools');
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'Task']) expect(denied).toContain(tool);
  });

  it('keeps the trace directory away from a role that can write', () => {
    const args = buildClaudeCliArgs(request({ toolPolicy: 'read-write', readDirs: ['/logs/run-1'] }));

    expect(valuesOf(args, '--add-dir')).toEqual(['/repo']);
    expect(valuesOf(args, '--allowed-tools')).toEqual(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep']);
    expect(valuesOf(args, '--disallowed-tools')).not.toContain('Write');
    expect(valuesOf(args, '--disallowed-tools')).toContain('Bash');
  });

  it('gives a role with no tools nothing at all', () => {
    const args = buildClaudeCliArgs(request({ toolPolicy: 'none', readDirs: ['/logs/run-1'] }));

    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('--allowed-tools');
    expect(valuesOf(args, '--disallowed-tools')).toEqual(expect.arrayContaining(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']));
  });
});

describe('the note that tells an agent what it really has', () => {
  it('translates the factory\'s tool names for a read-only role, and says where the earlier reports are', () => {
    const note = executionEnvironmentNote('read-only', 'triage', '/repo', { traceDir: '/logs/run-1' });

    expect(note).toContain('`read-file` is Read');
    expect(note).toContain('`search-repository` is Grep');
    expect(note).toContain('`run-test-suite`');
    expect(note).toContain('are not available');
    expect(note).toContain('files you can read in `/logs/run-1`');
    expect(note).toContain('replaces `read-run-artifacts`');
    expect(note).not.toContain('`write-file`');
  });

  it('adds the write tools for the developer, and no trace directory', () => {
    const note = executionEnvironmentNote('read-write', 'developer', '/repo', { traceDir: '/logs/run-1' });

    expect(note).toContain('`write-file` and `edit-file` are Write and Edit');
    expect(note).not.toContain('/logs/run-1');
    expect(note).toContain('NOT a reason to report PARTIAL');
  });

  it('says there are no tools when there are none', () => {
    const note = executionEnvironmentNote('none', 'pr-writer', '/repo');
    expect(note).toContain('You have no tools');
  });
});
