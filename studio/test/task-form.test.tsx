// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import App from '../src/App';
import { TaskInput } from '../src/components/TaskInput';
import { appHandlers, idleWatcher, installFakeApi, PLACES, REPO_PATH } from './support/fake-api';

const form = (over: Partial<React.ComponentProps<typeof TaskInput>> = {}) => {
  const props = {
    repoName: 'invest-track', repoPath: REPO_PATH, places: { worktreesDir: '/home/dev/workspace/.factory/worktrees/', volatile: false }, value: 'Add pagination', onChange: vi.fn(), onSubmit: vi.fn(), loading: false,
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

  it('says why a task could not start - in the main process\'s words, not Electron\'s wrapper around them', async () => {
    const { api, user } = await start({
      'factory:run-task': () => {
        throw new Error("Error invoking remote method 'factory:run-task': Error: Authentication required. Please log in to Claude CLI.");
      },
    });

    await user.type(screen.getByPlaceholderText(/Add dark mode/), 'Add pagination to the positions endpoint');
    await user.click(screen.getByRole('button', { name: 'Run Factory' }));

    await waitFor(() => expect(api.callsTo('factory:run-task').length).toBe(1));
    expect(await screen.findByText('Task execution failed: Authentication required. Please log in to Claude CLI.')).toBeTruthy();
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
  });

  it('previews the folder the factory says it will make checkouts in - not one worked out from Settings', async () => {
    await start({
      // Settings say one workspace; the factory - which knows its environment, its .env and what it was handed - says another.
      'settings:get': () => ({
        global: { theme: 'light', workspaceRoot: '/home/dev/workspace', defaultMaxAttempts: 3, dryRunByDefault: false, logLevel: 'info', activeProvider: 'claude-cli' },
        repos: {},
      }),
      'places:get': () => ({ ...PLACES, workspaceRoot: '/srv/code', worktreesDir: '/srv/checkouts' }),
    });

    expect(await screen.findByText('/srv/checkouts/invest-track/<task id>')).toBeTruthy();
  });

  it('asks the factory again where it works once Settings are saved - the folder may have been changed', async () => {
    let folder = '/home/dev/workspace/.factory/worktrees';
    const { api, user } = await start({
      'places:get': () => ({ ...PLACES, worktreesDir: folder }),
      'settings:update': () => undefined,
      'pr-watch:get-settings': () => ({ defaults: idleWatcher().settings, repos: {} }),
      'pr-watch:save-settings': () => undefined,
    });
    await screen.findByText(`${folder}/invest-track/<task id>`);
    const asked = api.callsTo('places:get').length;

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    folder = '/home/dev/checkouts'; // what the factory will say after the save
    await user.type(await screen.findByLabelText('Where worktrees are kept'), folder);
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByText('/home/dev/checkouts/invest-track/<task id>')).toBeTruthy();
    expect(api.callsTo('places:get').length).toBeGreaterThan(asked);
  });

  it('warns on the form when that folder is where a restart clears it', async () => {
    await start({ 'places:get': () => ({ ...PLACES, worktreesDir: '/tmp/factory-demo/workspace/.factory/worktrees', volatile: true }) });

    expect((await screen.findByTestId('volatile-folder')).textContent).toContain('a restart can clear it');
    expect(screen.getByText('/tmp/factory-demo/workspace/.factory/worktrees/invest-track/<task id>')).toBeTruthy();
  });

  it('does not warn about a folder that stays - nor when the task works in the repository, which has no checkout', async () => {
    const { user } = await start();
    await screen.findByText('/home/dev/workspace/.factory/worktrees/invest-track/<task id>');
    expect(screen.queryByTestId('volatile-folder')).toBeNull();

    await user.click(screen.getByRole('radio', { name: /My repository/ }));
    expect(screen.queryByTestId('volatile-folder')).toBeNull();
  });

  it('says where it will be made without guessing until the factory has answered', async () => {
    await start({ 'places:get': () => new Promise(() => {}) });

    expect(screen.getByTestId('isolation-preview').textContent).toContain('<where checkouts are kept>/invest-track/<task id>');
  });
});

describe('the volatile warning on the form itself', () => {
  it('shows only for an isolated worktree', () => {
    form({ places: { worktreesDir: '/tmp/x', volatile: true } });
    expect(screen.getByTestId('volatile-folder')).toBeTruthy();
  });

  it('is not shown for the repository itself, or for a folder that stays', () => {
    form({ isolation: 'in-place', places: { worktreesDir: '/tmp/x', volatile: true } });
    expect(screen.queryByTestId('volatile-folder')).toBeNull();
  });
});
