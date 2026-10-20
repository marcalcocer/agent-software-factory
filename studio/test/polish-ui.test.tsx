// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { AgentDetail } from '../src/components/AgentDetail';
import { PipelineSelector } from '../src/components/PipelineSelector';
import type { PipelineNode } from '../shared/pipelineState';
import type { PipelineConfig, RunArtifact } from '../shared/types';

const node: PipelineNode = { id: 'polish', name: 'Polish', icon: '✨', status: 'completed', attempt: 1, kind: 'step', artifactStep: 'polish' };
const candidates = [
  { id: 'REV-1', source: 'review', severity: 'MINOR', file: 'ui/src/Summary.jsx', line: 57, problem: 'Sign colour reveals the hidden sign', fix: 'Pass a neutral class' },
  { id: 'REV-2', source: 'review', severity: 'MINOR', file: 'ui/src/theme.test.js', line: 1, problem: 'var and const are mixed', fix: 'Use var' },
  { id: 'QA-1', source: 'qa', severity: 'MINOR', file: null, line: null, problem: 'Toolbar contrast in dark mode', fix: 'Add a CSS override' },
];

const polishView = (status: string, data: Record<string, unknown>) => {
  const artifact: RunArtifact = { step: 'polish', attempt: 1, status, data: { candidates: [], applied: [], declined: [], unanswered: [], reported: [], changedFiles: [], changedLines: 0, ...data } };
  render(<AgentDetail step="polish" node={node} artifact={artifact} logs={[]} isRunning={false} error={null} events={[]} pendingInput={null} />);
};

describe('the Polish report', () => {
  it('shows what was fixed, what was not and why, and what was only reported', () => {
    polishView('APPLIED', {
      candidates,
      applied: ['REV-1'],
      declined: [{ id: 'REV-2', reason: 'the rule is written for Java' }],
      unanswered: ['QA-1'],
      reported: [{ source: 'security', summary: 'XSS in ui/src/lib/ChartUtils.js:37', reason: 'it was there before this change' }],
      changedFiles: ['ui/src/Summary.jsx'],
      changedLines: 4,
      developerSummary: 'Fixed the colour.',
    });

    expect(screen.getByText('Fixed (1)')).toBeTruthy();
    expect(screen.getByText('Sign colour reveals the hidden sign')).toBeTruthy();
    expect(screen.getByText(/after the review approved the code/)).toBeTruthy(); // the reader is told code changed after the gates
    expect(screen.getByText('Not fixed (2)')).toBeTruthy();
    expect(screen.getByText('Not fixed: the rule is written for Java')).toBeTruthy();
    expect(screen.getByText('Reported, never acted on')).toBeTruthy();
    expect(screen.getByText(/XSS in ui\/src\/lib\/ChartUtils.js:37/)).toBeTruthy();
  });

  it('says plainly that the work is as it was when the polish was undone', () => {
    polishView('REVERTED', { candidates, detail: 'The test suite failed after the fixes (exit 1).' });

    expect(screen.getByText('Undone: the work is as it was before the polish')).toBeTruthy();
    expect(screen.getByText(/test suite failed after the fixes/)).toBeTruthy();
    expect(screen.queryByText(/^Fixed \(/)).toBeNull();
    expect(screen.getByText('Not fixed (3)')).toBeTruthy();
  });

  it.each([
    ['NONE', {}, /left no minor findings to fix/],
    ['SKIPPED', { reason: 'DISABLED' }, /Switched off for this task/],
    ['SKIPPED', { reason: 'NEEDS_QA' }, /needs the QA stage/],
    ['DECLINED', { reason: 'NO_CHANGES' }, /changed nothing/],
  ])('says what happened for %s %j', (status, data, text) => {
    polishView(status, data);
    expect(screen.getByText(text)).toBeTruthy();
  });
});

describe('the Polish switch in the task form', () => {
  function Form({ initial }: { initial: PipelineConfig }) {
    const [config, setConfig] = useState(initial);
    return (
      <>
        <PipelineSelector value={config} onChange={setConfig} />
        <output data-testid="config">{JSON.stringify(config)}</output>
      </>
    );
  }
  const all: PipelineConfig = { qa: true, review: true, security: true, documentation: true, polish: true };
  const open = async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Pipeline/ }));
    return user;
  };
  const polishBox = () => screen.getByRole('checkbox', { name: /Polish/ }) as HTMLInputElement;
  const config = () => JSON.parse(screen.getByTestId('config').textContent!);

  it('is on by default and can be switched off', async () => {
    render(<Form initial={all} />);
    const user = await open();

    expect(polishBox().checked).toBe(true);
    await user.click(polishBox());
    expect(config().polish).toBe(false);
  });

  it('cannot be on without QA, which checks its fixes, and says so', async () => {
    render(<Form initial={{ ...all, qa: false }} />);
    await open();

    expect(polishBox().checked).toBe(false);
    expect(polishBox().disabled).toBe(true);
    expect(screen.getAllByText(/Needs QA Testing, which checks the fixes/).length).toBeGreaterThan(0);
  });

  it('reads a stored selection from before the pass existed as polish on', async () => {
    const { polish: _omit, ...old } = all;
    render(<Form initial={old} />);
    await open();
    expect(polishBox().checked).toBe(true);
  });
});
