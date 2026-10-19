import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { readEvents, traceDirFor } from '../src/tools/logger-tools.ts';
import { getFactoryConfig } from '../src/utils/factory-config.ts';
import { qualityGatesSection, type PrTextContext } from '../src/tools/pr-text.ts';
import { diffCoverageNotes, loadDiffView } from '../src/workflows/software-factory.workflow.ts';
import type { RunContext } from '../src/utils/schemas.ts';
import { BIG_CHANGE_FILES, createBigChangeRepo } from './support/git-repo';

let repo: string;
let cleanup: () => void;
let logs: string;

beforeAll(() => {
  ({ repo, cleanup } = createBigChangeRepo());
});
afterAll(() => cleanup());

beforeEach(() => {
  logs = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-diff-wiring-'));
  vi.stubEnv('FACTORY_LOG_DIR', logs);
  // The change is about 200,000 characters: bigger than the default budget, so tests that want to
  // see all of it say so, and the ones about a partial view lower it.
  vi.stubEnv('FACTORY_DIFF_BUDGET_CHARS', '400000');
});
afterEach(() => {
  fs.rmSync(logs, { recursive: true, force: true });
});

/** The parts of a run the diff view reads. */
const runOf = (runId: string): RunContext => ({ runId, repoPath: repo, dryRun: false }) as RunContext;

describe('what the gates are given of a big change', () => {
  it('saves the COMPLETE patch for the agent to read, whatever it is shown', async () => {
    const { files } = await loadDiffView(runOf('r1'), 1, 'review');

    const patch = fs.readFileSync(path.join(traceDirFor('r1'), 'context', 'diff-attempt-1.patch'), 'utf8');
    expect(patch.length).toBeGreaterThan(60_000); // the old cap kept 24,040 of it
    expect(patch).not.toContain('characters truncated');
    expect(files).toHaveLength(BIG_CHANGE_FILES + 1);
    expect((patch.match(/^diff --git /gm) ?? []).length).toBe(BIG_CHANGE_FILES + 1);
  });

  it('shows the whole change when it fits the budget, and says so', async () => {
    expect(getFactoryConfig().diffBudgetChars).toBe(400_000);
    const { view } = await loadDiffView(runOf('r2'), 1, 'review');

    expect(view!.coverage).toMatchObject({ totalFiles: BIG_CHANGE_FILES + 1, inFull: BIG_CHANGE_FILES + 1, complete: true });
    expect(view!.text).toContain('This is the complete diff');
    expect(view!.text).toContain('value20_17');
  });

  it('records what each gate was shown, so that it can be audited', async () => {
    await loadDiffView(runOf('r3'), 2, 'security');

    const [event] = readEvents('r3').filter((e) => e.type === 'diff_view');
    expect(event).toMatchObject({ audience: 'security', attempt: 2, totalFiles: BIG_CHANGE_FILES + 1, complete: true });
    expect((event as unknown as { chars: number }).chars).toBeGreaterThan(60_000);
  });

  it('shows QA less of it, because QA reads the code with its tools', async () => {
    const qa = await loadDiffView(runOf('r4'), 1, 'qa');
    const review = await loadDiffView(runOf('r4'), 1, 'review');

    expect(qa.view!.text.length).toBeLessThanOrEqual(60_000);
    expect(qa.view!.coverage.complete).toBe(false);
    expect(review.view!.coverage.complete).toBe(true);
  });

  it('does nothing in a dry run, where there is no repository to read', async () => {
    expect(await loadDiffView({ ...runOf('r5'), dryRun: true }, 1, 'review')).toEqual({ files: [], view: null });
  });
});

describe('telling the pull request what a gate did not see', () => {
  it('turns a partial look into a note on that gate, and a later complete look into none', async () => {
    vi.stubEnv('FACTORY_DIFF_BUDGET_CHARS', '30000');
    await loadDiffView(runOf('r6'), 1, 'review');
    await loadDiffView(runOf('r6'), 1, 'security');
    expect(Object.keys(diffCoverageNotes('r6')).sort()).toEqual(['review', 'security']);
    expect(diffCoverageNotes('r6').review).toMatch(/^\d+ of 41 changed files seen in full$/);

    vi.stubEnv('FACTORY_DIFF_BUDGET_CHARS', '400000');
    await loadDiffView(runOf('r6'), 2, 'review'); // the final attempt saw everything
    expect(Object.keys(diffCoverageNotes('r6'))).toEqual(['security']);
  });

  it('puts the note in the quality gates of the description, and only on the gates it concerns', () => {
    const context = {
      task: 't',
      plan: null,
      developer: null,
      qa: { verdict: 'PASS', totals: { tests: 5, passed: 5, failed: 0, skipped: 0 } },
      review: { status: 'APPROVED' },
      security: { status: 'PASS', riskLevel: 'NONE' },
      documentation: null,
      pipeline: { qa: true, review: true, security: true, documentation: false },
      files: [],
      coverage: { review: '25 of 31 changed files seen in full' },
    } as unknown as PrTextContext;

    const section = qualityGatesSection(context);
    expect(section).toContain('- Code review: APPROVED - 25 of 31 changed files seen in full');
    expect(section).toContain('- Security audit: PASS (no risk found)\n');
    expect(section).toContain('- QA: PASS - 5 of 5 tests passed\n');
  });
});
