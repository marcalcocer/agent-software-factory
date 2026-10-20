// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import App from '../src/App';
import { TaskInput } from '../src/components/TaskInput';
import { appHandlers, installFakeApi, REPO_PATH } from './support/fake-api';

const form = (over: Partial<React.ComponentProps<typeof TaskInput>> = {}) => {
  const props = {
    repoName: 'invest-track', repoPath: REPO_PATH, workspaceRoot: '/home/dev/workspace/', value: 'Add pagination', onChange: vi.fn(), onSubmit: vi.fn(), loading: false,
    hasHistory: false, pipeline: { qa: true, review: true, security: true, documentation: true, polish: true }, onPipelineChange: vi.fn(),
    isolation: 'worktree' as const, onIsolationChange: vi.fn(), phasing: 'auto' as const, onPhasingChange: vi.fn(), ...over,
  };
  render(<TaskInput {...props} />);
  return props;
};

describe('where the task will work - on the form', () => {
  it('offers an isolated worktree first, as the recommended way, and says what the folder will be', () => {
    form();

    const worktree = screen.getByRole('radio', { name: /Isolated worktree/ }) as HTMLInputElement;
    expect(worktree.checked).toBe(true);
    expect(screen.getByText('(recommended)')).toBeTruthy();
    expect(screen.getByTestId('isolation-preview').textContent).toBe(
      'It gets a copy of its own, on its own branch, in /home/dev/workspace/.factory/worktrees/invest-track/<task id>. The exact folder is shown on the run, once it starts.',
    );
  });

  it('says what it would be when the task works in the repository instead', () => {
    form({ isolation: 'in-place' });

    expect((screen.getByRole('radio', { name: /My repository/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('isolation-preview').textContent).toBe(`It works in ${REPO_PATH} itself.`);
  });

  it('tells the user what each costs: the repository is switched and must be clean', () => {
    form();

    expect(screen.getByText('It switches the branch there, and needs it to have no uncommitted changes.')).toBeTruthy();
    expect(screen.getByText(/Your folder is not touched and may have changes; other tasks can run at the same time/)).toBeTruthy();
  });

  it('reports the choice', async () => {
    const props = form();
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: /My repository/ }));

    expect(props.onIsolationChange).toHaveBeenCalledWith('in-place');
  });

  it('is on both forms: the welcome form of a repository with no history, and the compact one with it', () => {
    form({ hasHistory: true });

    expect(screen.getByTestId('execution-options')).toBeTruthy();
    expect(screen.getByPlaceholderText(/Describe your next task/)).toBeTruthy();
  });

  it('asks whether the architect may split the request into phases, defaulting to letting it decide', async () => {
    const props = form();
    const user = userEvent.setup();
    const select = screen.getByLabelText('Plan in phases') as HTMLSelectElement;

    expect(select.value).toBe('auto');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Let the architect decide', 'Plan in phases', 'One pull request']);
    await user.selectOptions(select, 'on');

    expect(props.onPhasingChange).toHaveBeenCalledWith('on');
  });

  it('does not hold a worktree task up for a run in the repository - only an in-place one waits', () => {
    const blocked = { message: 'Another run is using the repository.', onOpen: () => {} };

    const { unmount } = render(<TaskInput {...{ repoName: 'r', value: 'x', onChange: () => {}, onSubmit: () => {}, loading: false, hasHistory: false, pipeline: { qa: true, review: true, security: true, documentation: true }, onPipelineChange: () => {}, isolation: 'worktree' as const, onIsolationChange: () => {}, phasing: 'auto' as const, onPhasingChange: () => {}, blocked }} />);
    expect(screen.queryByTestId('task-blocked')).toBeNull();
    expect((screen.getByRole('button', { name: 'Run Factory' }) as HTMLButtonElement).disabled).toBe(false);
    unmount();

    render(<TaskInput {...{ repoName: 'r', value: 'x', onChange: () => {}, onSubmit: () => {}, loading: false, hasHistory: false, pipeline: { qa: true, review: true, security: true, documentation: true }, onPipelineChange: () => {}, isolation: 'in-place' as const, onIsolationChange: () => {}, phasing: 'auto' as const, onPhasingChange: () => {}, blocked }} />);
    expect(screen.getByTestId('task-blocked').textContent).toContain('Another run is using the repository.');
    expect((screen.getByRole('button', { name: 'Run Factory' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('what the form sends', () => {
  const start = async (handlers: Record<string, (...args: any[]) => unknown> = {}) => {
    const api = installFakeApi(appHandlers({ 'factory:list': () => [], 'factory:run-task': () => new Promise(() => {}), ...handlers }));
    const user = userEvent.setup();
    render(<App />);
    await user.click((await screen.findAllByRole('button', { name: /invest-track/ }))[0]!);
    await screen.findByText(/New Task for invest-track/);
    return { api, user };
  };

  it('is an isolated worktree, left to the architect to split, unless the user says otherwise', async () => {
    const { api, user } = await start();

    await user.type(screen.getByPlaceholderText(/Add dark mode/), 'Add pagination to the positions endpoint');
    await user.click(screen.getByRole('button', { name: 'Run Factory' }));

    await waitFor(() => expect(api.callsTo('factory:run-task').length).toBe(1));
    expect(api.callsTo('factory:run-task')[0]![0]).toMatchObject({ repo: 'invest-track', repoPath: REPO_PATH, isolation: 'worktree', phasing: 'auto' });
  });

  it('is what the user chose on the form', async () => {
    const { api, user } = await start();

    await user.click(screen.getByRole('radio', { name: /My repository/ }));
    await user.selectOptions(screen.getByLabelText('Plan in phases'), 'on');
    await user.type(screen.getByPlaceholderText(/Add dark mode/), 'Redo the whole interface');
    await user.click(screen.getByRole('button', { name: 'Run Factory' }));

    await waitFor(() => expect(api.callsTo('factory:run-task').length).toBe(1));
    expect(api.callsTo('factory:run-task')[0]![0]).toMatchObject({ isolation: 'in-place', phasing: 'on' });
  });

  it('starts from the default in Settings', async () => {
    const { api } = await start({
      'settings:get': () => ({
        global: { theme: 'light', workspaceRoot: '/home/dev/workspace', defaultMaxAttempts: 3, dryRunByDefault: false, logLevel: 'info', activeProvider: 'claude-cli', isolation: 'in-place' },
        repos: {},
      }),
    });

    expect((screen.getByRole('radio', { name: /My repository/ }) as HTMLInputElement).checked).toBe(true);
    expect(api.callsTo('settings:get').length).toBeGreaterThan(0);
  });

  it('previews the folder under the workspace Settings names', async () => {
    await start({
      'settings:get': () => ({
        global: { theme: 'light', workspaceRoot: '/srv/code', defaultMaxAttempts: 3, dryRunByDefault: false, logLevel: 'info', activeProvider: 'claude-cli' },
        repos: {},
      }),
    });

    expect(await screen.findByText('/srv/code/.factory/worktrees/invest-track/<task id>')).toBeTruthy();
  });
});
