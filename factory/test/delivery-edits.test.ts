import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUNS_DIR, RUN } from '../../fixtures';
import {
  currentWorkBranch,
  earlierDeliveryActions,
  latestDeliveryEdits,
  parseDeliveryEditsJson,
  sanitizeDeliveryEdits,
} from '../src/utils/delivery-edits.ts';

describe('what the human changed at the delivery gate, from real runs', () => {
  beforeEach(() => {
    vi.stubEnv('FACTORY_LOG_DIR', RUNS_DIR);
  });

  it('finds the final values the human submitted in round 1', () => {
    const edits = latestDeliveryEdits(RUN.round1);

    // The form always sends all four fields, whether or not the human changed them.
    expect(Object.keys(edits).sort()).toEqual(['branchName', 'commitMessage', 'pullRequestBody', 'pullRequestTitle']);
    expect(edits.branchName).toBe('factory/i-want-to-do-a-big-refactor-on-t-61e6');
    expect(edits.pullRequestTitle).toBe('feat(ui): add design tokens, dark mode and modern app shell');
    expect(edits.pullRequestBody).toMatch(/^## Summary/);
  });

  it('finds only the commit message in round 2, where the pull request text is not touched', () => {
    const edits = latestDeliveryEdits(RUN.round2);

    expect(Object.keys(edits)).toEqual(['commitMessage']);
    expect(edits.commitMessage).toMatch(/^chore: address review feedback on PR #8 \(round 2\)/);
  });

  it('has nothing for a run that never reached the gate', () => {
    expect(latestDeliveryEdits(RUN.prTriage)).toEqual({});
  });

  it('remembers what delivery did before the approval, so its report is whole', () => {
    // The commit is made before the gate; the execution that writes the report comes after it.
    const actions = earlierDeliveryActions(RUN.round1);

    expect(actions.map((a) => [a.action, a.ok])).toEqual([
      ['commit', true],
      ['push', true],
      ['pull-request', true],
    ]);
    expect(actions[0]!.detail).toContain('Committed 33b75a3');
  });

  it('keeps the branch name when it was never renamed', () => {
    expect(currentWorkBranch(RUN.round1, 'factory/x')).toBe('factory/x');
  });
});

describe('following a renamed branch', () => {
  let logs: string;
  beforeEach(() => {
    logs = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-edits-'));
    vi.stubEnv('FACTORY_LOG_DIR', logs);
  });
  afterEach(() => {
    fs.rmSync(logs, { recursive: true, force: true });
  });

  const writeEvents = (events: Array<Record<string, unknown>>) => {
    fs.mkdirSync(path.join(logs, 'r1'), { recursive: true });
    fs.writeFileSync(path.join(logs, 'r1', 'events.ndjson'), events.map((e) => JSON.stringify(e)).join('\n'));
  };

  it('follows a chain of renames, in order', () => {
    writeEvents([
      { type: 'branch_renamed', from: 'a', to: 'b' },
      { type: 'branch_renamed', from: 'b', to: 'c' },
    ]);
    expect(currentWorkBranch('r1', 'a')).toBe('c');
  });

  it('ignores a rename of some other branch', () => {
    writeEvents([{ type: 'branch_renamed', from: 'other', to: 'x' }]);
    expect(currentWorkBranch('r1', 'a')).toBe('a');
  });

  it('lets an approval without edits leave the earlier edits standing', () => {
    writeEvents([
      { type: 'human_input', gate: 'DELIVERY_APPROVAL_REQUIRED', edits: { pullRequestTitle: 'Edited title' } },
      { type: 'human_input', gate: 'DELIVERY_APPROVAL_REQUIRED', approvePush: true },
    ]);
    expect(latestDeliveryEdits('r1')).toEqual({ pullRequestTitle: 'Edited title' });
  });
});

describe('sanitizeDeliveryEdits', () => {
  it('ignores what is blank, because blank means "keep the proposal"', () => {
    expect(sanitizeDeliveryEdits({ pullRequestTitle: '  ', commitMessage: '\n', branchName: ' ' })).toEqual({});
    expect(sanitizeDeliveryEdits(null)).toEqual({});
    expect(sanitizeDeliveryEdits(undefined)).toEqual({});
  });

  it('keeps a title on one line and trims the rest', () => {
    expect(
      sanitizeDeliveryEdits({
        pullRequestTitle: ' Add\n  pagination ',
        commitMessage: 'feat: x\r\n\r\nbody  ',
        branchName: ' factory/x ',
      }),
    ).toEqual({ pullRequestTitle: 'Add pagination', commitMessage: 'feat: x\n\nbody', branchName: 'factory/x' });
  });

  it('allows the description to be emptied on purpose', () => {
    expect(sanitizeDeliveryEdits({ pullRequestBody: '' })).toEqual({ pullRequestBody: '' });
  });
});

describe('parseDeliveryEditsJson', () => {
  it('reads what the Studio sends', () => {
    expect(parseDeliveryEditsJson('{"pullRequestTitle":"T","commitMessage":"feat: x"}')).toEqual({
      pullRequestTitle: 'T',
      commitMessage: 'feat: x',
    });
  });

  it('drops unknown keys and values of the wrong type instead of failing the delivery', () => {
    expect(parseDeliveryEditsJson('{"pullRequestTitle":42,"hack":"x","branchName":"b"}')).toEqual({ branchName: 'b' });
  });

  it('survives garbage and nothing at all', () => {
    expect(parseDeliveryEditsJson('{not json')).toEqual({});
    expect(parseDeliveryEditsJson(undefined)).toEqual({});
    expect(parseDeliveryEditsJson('')).toEqual({});
  });
});
