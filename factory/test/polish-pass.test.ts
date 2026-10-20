import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { changesSince, restoreWorkingTree, snapshotWorkingTree } from '../src/tools/git-tools.ts';
import type { CheckResult, PolishInput } from '../src/tools/polish.ts';
import { polishPrompt, runPolishPass, type PolishDeps, type PolishRequest } from '../src/workflows/polish-pass.ts';
import type { DeveloperReport, QaReport, ReviewReport, SecurityReport } from '../src/utils/schemas.ts';
import { createBigChangeRepo } from './support/git-repo';

/**
 * The polish pass on a real repository (the work of a run, uncommitted) with a stand-in developer that
 * edits real files. Only the model and the test runner are replaced.
 */
let repo: string;
let git: (...args: string[]) => string;
let cleanup: () => void;

beforeEach(() => {
  ({ repo, git, cleanup } = createBigChangeRepo());
});
afterEach(() => cleanup());

const file = (name: string) => path.join(repo, name);
const read = (name: string) => fs.readFileSync(file(name), 'utf8');
const status = () => git('status', '--porcelain').split('\n').filter(Boolean).sort();

const gates: PolishInput = {
  qa: {
    bugReports: [{ title: 'Sign colour leaks', severity: 'MINOR', stepsToReproduce: [], expected: 'No colour when private', actual: 'Green or red', evidence: 'src/file03.ts:1' }],
  } as unknown as QaReport,
  review: {
    findings: [
      { severity: 'MINOR', file: 'src/file03.ts', line: 1, issue: 'Stale comment', suggestion: 'Remove the comment.', rule: null },
      { severity: 'MINOR', file: 'src/file04.ts', line: 1, issue: 'Style', suggestion: 'Use var.', rule: null },
    ],
  } as ReviewReport,
  security: { findings: [] } as unknown as SecurityReport,
};

const passing: CheckResult = { testExit: 0, buildExit: 0, totals: { tests: 62, passed: 62, failed: 0, skipped: 0 } };

const report = (over: Partial<DeveloperReport> = {}): DeveloperReport => ({
  status: 'COMPLETED',
  summary: 'Fixed what was clearly right.',
  changedFiles: [],
  testsAdded: [],
  commandsRun: [],
  appliedFeedback: [],
  selfVerification: { localTestsPassed: false, notes: '' },
  followUps: [],
  blockers: [],
  ...over,
});

/** The real git and the real filesystem; the developer and the test runner are whatever the test says. */
function depsWith(over: { developer: (prompt: string) => Promise<DeveloperReport> | DeveloperReport; checks?: () => CheckResult | Promise<CheckResult> }) {
  const notes: Array<Record<string, unknown>> = [];
  const prompts: string[] = [];
  const deps: PolishDeps = {
    snapshot: () => snapshotWorkingTree(repo),
    restore: (tree) => restoreWorkingTree(repo, tree),
    changesSince: (tree) => changesSince(repo, tree),
    runChecks: async () => (over.checks ? over.checks() : passing),
    askDeveloper: async (prompt, _candidates) => {
      prompts.push(prompt);
      return over.developer(prompt);
    },
    note: (event) => notes.push(event),
  };
  return { deps, notes, prompts };
}

const request = (over: Partial<PolishRequest> = {}): PolishRequest => ({
  gates,
  enabled: true,
  qaEnabled: true,
  dryRun: false,
  before: { tests: 61, passed: 61, failed: 0, skipped: 0 },
  context: ['## Original task\n\nAdd dark mode.\n'],
  ...over,
});

describe('a polish pass that works', () => {
  it('keeps the fixes, says which findings they answered, and counts what changed', async () => {
    const { deps, notes } = depsWith({
      developer: () => {
        fs.writeFileSync(file('src/file03.ts'), 'export const fixed = true;\n');
        return report({
          appliedFeedback: ['QA-1: neutral colour when private', 'REV-1: removed the stale comment'],
          followUps: ['REV-2: Not applied - the rule is written for Java'],
        });
      },
    });

    const result = await runPolishPass(request(), deps);

    expect(result).toMatchObject({
      status: 'APPLIED',
      applied: ['QA-1', 'REV-1'],
      declined: [{ id: 'REV-2', reason: 'the rule is written for Java' }],
      unanswered: [],
      changedFiles: ['src/file03.ts'],
    });
    expect(result.changedLines).toBeGreaterThan(0);
    expect(read('src/file03.ts')).toBe('export const fixed = true;\n'); // the fix is still in the working tree
    expect(notes.map((n) => n.type)).toEqual(['polish_asking']);
  });

  it('hands the developer the context, every finding with its id, and the rules of the pass', async () => {
    const { deps, prompts } = depsWith({ developer: () => report() });
    await runPolishPass(request(), deps);

    expect(prompts[0]).toContain('# Polish pass');
    expect(prompts[0]).toContain('Add dark mode.');
    for (const id of ['QA-1', 'REV-1', 'REV-2']) expect(prompts[0]).toContain(`### ${id} `);
    expect(prompts[0]).toContain('Start every entry with the finding id');
    expect(prompts[0]).toContain('If they fail, everything you did is undone');
  });
});

describe('a polish pass that is undone', () => {
  it('puts the working tree back exactly when the tests fail afterwards', async () => {
    const before = status();
    const original = read('src/file03.ts');
    const { deps, notes } = depsWith({
      developer: () => {
        fs.writeFileSync(file('src/file03.ts'), 'broken\n');
        fs.writeFileSync(file('src/new-by-polish.ts'), 'export const x = 1;\n');
        fs.rmSync(file('src/file01.ts'));
        return report({ appliedFeedback: ['QA-1: done', 'REV-1: done'] });
      },
      checks: () => ({ testExit: 1, buildExit: 0, totals: { tests: 62, passed: 60, failed: 2, skipped: 0 } }),
    });

    const result = await runPolishPass(request(), deps);

    expect(result).toMatchObject({ status: 'REVERTED', reason: 'CHECKS_FAILED', applied: [], changedFiles: [] });
    expect(result.detail).toContain('test suite failed');
    expect(read('src/file03.ts')).toBe(original);
    expect(fs.existsSync(file('src/new-by-polish.ts'))).toBe(false);
    expect(fs.existsSync(file('src/file01.ts'))).toBe(true);
    expect(status()).toEqual(before);
    expect(notes.map((n) => n.type)).toContain('polish_undone');
  });

  it('undoes a polish that grew into a change of its own', async () => {
    const { deps } = depsWith({
      developer: () => {
        for (let i = 0; i < 12; i += 1) fs.writeFileSync(file(`src/file${String(i).padStart(2, '0')}.ts`), `// touched ${i}\n`);
        return report({ appliedFeedback: ['REV-1: rewrote everything'] });
      },
    });
    const result = await runPolishPass(request(), deps);

    expect(result).toMatchObject({ status: 'REVERTED', reason: 'TOO_LARGE' });
    expect(read('src/file00.ts')).toContain('after-');
  });

  it('undoes a polish that takes assertions out of a test, even though everything is green', async () => {
    fs.mkdirSync(file('src/__tests__'), { recursive: true });
    fs.writeFileSync(file('src/__tests__/a.test.js'), "it('masks money', () => {\n  expect(mask(1)).toBe('***');\n});\n");
    const { deps } = depsWith({
      developer: () => {
        fs.writeFileSync(file('src/__tests__/a.test.js'), "// the test was inconvenient\n");
        return report({ appliedFeedback: ['REV-1: simplified the test'] });
      },
    });
    const result = await runPolishPass(request(), deps);

    expect(result).toMatchObject({ status: 'REVERTED', reason: 'WEAKENED_TESTS' });
    expect(read('src/__tests__/a.test.js')).toContain("expect(mask(1)).toBe('***')");
  });

  it('undoes a polish after which fewer tests pass', async () => {
    const { deps } = depsWith({
      developer: () => {
        fs.writeFileSync(file('src/file03.ts'), 'x\n');
        return report({ appliedFeedback: ['REV-1: done'] });
      },
      checks: () => ({ testExit: 0, buildExit: 0, totals: { tests: 50, passed: 50, failed: 0, skipped: 0 } }),
    });
    expect(await runPolishPass(request(), deps)).toMatchObject({ status: 'REVERTED', reason: 'TESTS_LOST' });
  });

  it('puts everything back when the developer fails halfway, and carries on without failing the run', async () => {
    const before = status();
    const { deps } = depsWith({
      developer: () => {
        fs.writeFileSync(file('src/file03.ts'), 'half done\n');
        throw new Error('Claude subscription usage limit reached');
      },
    });

    const result = await runPolishPass(request(), deps);

    expect(result).toMatchObject({ status: 'FAILED', reason: 'DEVELOPER_ERROR' });
    expect(result.detail).toContain('usage limit');
    expect(status()).toEqual(before);
  });

  it('puts everything back when the developer says it is blocked', async () => {
    const before = status();
    const { deps } = depsWith({
      developer: () => {
        fs.writeFileSync(file('src/file03.ts'), 'half done\n');
        return report({ status: 'BLOCKED', blockers: ['needs a product decision'] });
      },
    });
    expect(await runPolishPass(request(), deps)).toMatchObject({ status: 'DECLINED', reason: 'BLOCKED', detail: 'needs a product decision' });
    expect(status()).toEqual(before);
  });

  it('does not hide it when the work cannot be put back', async () => {
    const { deps } = depsWith({
      developer: () => {
        fs.writeFileSync(file('src/file03.ts'), 'x\n');
        return report({ appliedFeedback: ['REV-1: done'] });
      },
      checks: () => ({ testExit: 1, buildExit: 0, totals: null }),
    });
    deps.restore = async () => {
      throw new Error('index.lock exists');
    };
    await expect(runPolishPass(request(), deps)).rejects.toThrow('could not undo its changes: index.lock exists');
  });
});

describe('a polish pass that does nothing', () => {
  it('is NONE when the gates left nothing minor, and never asks the developer', async () => {
    const { deps, prompts } = depsWith({ developer: () => report() });
    const result = await runPolishPass(request({ gates: { qa: null, review: null, security: null } }), deps);

    expect(result).toMatchObject({ status: 'NONE', candidates: [] });
    expect(prompts).toEqual([]);
  });

  it('is DECLINED when the developer read the findings and changed nothing', async () => {
    const { deps } = depsWith({
      developer: () => report({ followUps: ['QA-1: Not applied - wrong', 'REV-1: Not applied - wrong', 'REV-2: Not applied - style'] }),
    });
    const result = await runPolishPass(request(), deps);

    expect(result).toMatchObject({ status: 'DECLINED', reason: 'NO_CHANGES' });
    expect(result.declined).toHaveLength(3);
  });

  it('is SKIPPED when switched off, without reading the gates\' findings as work', async () => {
    const { deps, prompts } = depsWith({ developer: () => report() });
    expect(await runPolishPass(request({ enabled: false }), deps)).toMatchObject({ status: 'SKIPPED', reason: 'DISABLED' });
    expect(prompts).toEqual([]);
  });

  it('is SKIPPED when QA is off, because nothing would check the fixes', async () => {
    const { deps, prompts } = depsWith({ developer: () => report() });
    const result = await runPolishPass(request({ qaEnabled: false }), deps);

    expect(result).toMatchObject({ status: 'SKIPPED', reason: 'NEEDS_QA' });
    expect(result.reported).toEqual([]);
    expect(prompts).toEqual([]);
  });
});

describe('a repository git cannot snapshot', () => {
  it('leaves the work alone and says so, instead of failing the run', async () => {
    const { deps, prompts } = depsWith({ developer: () => report() });
    deps.snapshot = async () => {
      throw new Error('fatal: not a git repository');
    };

    const result = await runPolishPass(request(), deps);

    expect(result).toMatchObject({ status: 'FAILED', reason: 'SNAPSHOT_ERROR' });
    expect(result.detail).toContain('not a git repository');
    expect(prompts).toEqual([]); // the developer was never asked: nothing could have been undone
  });
});

describe('a dry run', () => {
  it('asks the stand-in developer and touches nothing', async () => {
    const before = status();
    const { deps } = depsWith({ developer: () => report({ appliedFeedback: ['QA-1: [dry-run] applied'] }) });
    deps.snapshot = deps.restore = deps.changesSince = deps.runChecks = async () => {
      throw new Error('a dry run must not touch git or run the tests');
    };

    const result = await runPolishPass(request({ dryRun: true }), deps);

    expect(result).toMatchObject({ status: 'APPLIED', dryRun: true, applied: ['QA-1'] });
    expect(status()).toEqual(before);
  });
});

describe('polishPrompt', () => {
  it('lists the context before the findings', () => {
    const prompt = polishPrompt({ context: ['## Original task\n\nX\n'] }, { candidates: [], reported: [] });
    expect(prompt.indexOf('Original task')).toBeLessThan(prompt.indexOf('Minor findings to fix'));
  });
});
