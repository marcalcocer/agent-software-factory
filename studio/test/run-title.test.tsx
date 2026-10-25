// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RUN, runDir } from '../../fixtures';
import { readRunState } from '../electron/services/run-state';
import { PipelineView } from '../src/components/PipelineView';
import { RunTitle } from '../src/components/RunTitle';
import type { FactoryRun, RunArtifact } from '../shared/types';
import { installFakeApi, openingARun } from './support/fake-api';

describe('the name of a run', () => {
  it('says who named it: the AI, the user, or the request when the AI could not', () => {
    const { rerender } = render(<RunTitle title="Dark mode for every screen" source="agent" />);
    expect(screen.getByTestId('run-title').textContent).toBe('Dark mode for every screen');
    expect(screen.getByTestId('run-title-source').textContent).toBe('🏷 named by AI');

    rerender(<RunTitle title="Add a dark mode" source="fallback" why="[claude-cli/rate-limit]: usage limit" />);
    expect(screen.getByTestId('run-title-source').textContent).toBe('🏷 from your request');
    expect(screen.getByTestId('run-title-source').getAttribute('title')).toContain('usage limit');

    rerender(<RunTitle title="My name" source="user" />);
    expect(screen.getByTestId('run-title-source').textContent).toBe('✎ renamed by you');
  });

  it('is renamed with a double-click: Enter saves, Escape leaves it as it was', async () => {
    const onRename = vi.fn(async () => {});
    const user = userEvent.setup();
    render(<RunTitle title="Dark mode" source="agent" onRename={onRename} />);

    await user.dblClick(screen.getByTestId('run-title'));
    const input = screen.getByTestId('run-title-input') as HTMLInputElement;
    expect(input.value).toBe('Dark mode');
    await user.clear(input);
    await user.type(input, 'Night theme{Enter}');
    expect(onRename).toHaveBeenCalledWith('Night theme');
    await waitFor(() => expect(screen.queryByTestId('run-title-input')).toBeNull());

    await user.dblClick(screen.getByTestId('run-title'));
    await user.type(screen.getByTestId('run-title-input'), ' extra{Escape}');
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('run-title-input')).toBeNull();
  });

  it('shows why a rename was refused, and stays open', async () => {
    const onRename = vi.fn(async () => {
      throw new Error('A name can have at most 120 characters.');
    });
    const user = userEvent.setup();
    render(<RunTitle title="Dark mode" onRename={onRename} />);
    await user.dblClick(screen.getByTestId('run-title'));
    await user.type(screen.getByTestId('run-title-input'), ' more{Enter}');
    expect(await screen.findByText('A name can have at most 120 characters.')).toBeTruthy();
    expect(screen.getByTestId('run-title-input')).toBeTruthy();
  });

  it('cannot be renamed where no rename is offered', async () => {
    render(<RunTitle title="Dark mode" source="agent" />);
    await userEvent.setup().dblClick(screen.getByTestId('run-title'));
    expect(screen.queryByTestId('run-title-input')).toBeNull();
    expect(screen.queryByLabelText('Rename this run')).toBeNull();
  });
});

describe('the name of a run, in its pipeline view', () => {
  const base = () => readRunState(runDir(RUN.round1), RUN.round1, false)!.run;
  const fallback: RunArtifact = {
    step: 'run-namer',
    attempt: 1,
    status: 'FALLBACK',
    data: { title: 'Add dark mode', slug: 'add-dark-mode', type: 'feat', error: 'Agent "run-namer" failed during step "run-namer" [claude-cli/rate-limit]: usage limit' },
  };

  it('is shown with who made it, renamed on the spot, and told to the history once - not on every render', async () => {
    let run: FactoryRun = { ...base(), title: 'Dark mode with a persisted toggle', titleSource: 'agent' };
    const api = installFakeApi({
      ...openingARun([RUN.round1]),
      'factory:get': () => run,
      'factory:rename-run': (_id: string, title: string) => {
        run = { ...run, title, titleSource: 'user' };
      },
    });
    const onTitleChanged = vi.fn();
    const { rerender } = render(<PipelineView runId={RUN.round1} isRunning={false} onClose={() => {}} onTitleChanged={onTitleChanged} />);

    expect((await screen.findByTestId('run-title')).textContent).toBe('Dark mode with a persisted toggle');
    expect(screen.getByTestId('run-title-source').textContent).toBe('🏷 named by AI');
    await waitFor(() => expect(onTitleChanged).toHaveBeenCalledWith(RUN.round1, 'Dark mode with a persisted toggle', 'agent'));

    // A parent that passes a new function on every render must not make the view tell it again.
    rerender(<PipelineView runId={RUN.round1} isRunning={false} onClose={() => {}} onTitleChanged={(...args) => onTitleChanged(...args)} />);
    rerender(<PipelineView runId={RUN.round1} isRunning={false} onClose={() => {}} onTitleChanged={(...args) => onTitleChanged(...args)} />);
    expect(onTitleChanged).toHaveBeenCalledTimes(1);

    const user = userEvent.setup();
    await user.dblClick(screen.getByTestId('run-title'));
    const input = screen.getByTestId('run-title-input');
    await user.clear(input);
    await user.type(input, 'Night theme{Enter}');
    await waitFor(() => expect(api.callsTo('factory:rename-run')).toEqual([[RUN.round1, 'Night theme']]));
    await waitFor(() => expect(screen.getByTestId('run-title').textContent).toBe('Night theme'));
    expect(screen.getByTestId('run-title-source').textContent).toBe('✎ renamed by you');
    expect(onTitleChanged).toHaveBeenLastCalledWith(RUN.round1, 'Night theme', 'user');
  });

  it('says when the AI could not name the run, and why', async () => {
    const run: FactoryRun = { ...base(), title: 'Add dark mode', titleSource: 'fallback' };
    const handlers = openingARun([RUN.round1]);
    const real = handlers['factory:get-artifacts'] as (id: string) => RunArtifact[];
    installFakeApi({ ...handlers, 'factory:get': () => run, 'factory:get-artifacts': (id: string) => [fallback, ...real(id)] });
    render(<PipelineView runId={RUN.round1} isRunning={false} onClose={() => {}} />);

    const source = await screen.findByTestId('run-title-source');
    expect(source.textContent).toBe('🏷 from your request');
    expect(source.getAttribute('title')).toContain('usage limit');
  });
});

