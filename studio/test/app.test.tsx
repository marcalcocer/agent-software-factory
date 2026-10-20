// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { RUN } from '../../fixtures';
import App from '../src/App';
import { appHandlers, installFakeApi, listOf, openingARun, REPO_PATH } from './support/fake-api';

/**
 * The whole screen, with the main process replaced by the real runs of the UI refactor: what the user
 * of the Studio saw go wrong, as they saw it.
 */
async function openRepository(api: ReturnType<typeof installFakeApi>) {
  const user = userEvent.setup();
  render(<App />);
  const [sidebarEntry] = await screen.findAllByRole('button', { name: /invest-track/ });
  await user.click(sidebarEntry!);
  await waitFor(() => expect(api.callsTo('factory:list').length).toBeGreaterThan(0));
  return user;
}

describe('the run history', () => {
  it('shows each run by the name stored with it, not as "Untitled run"', async () => {
    const withTitle = listOf([RUN.round1]).map((run) => ({ ...run, title: 'Professional redesign of the frontend', taskId: 'f0042' }));
    installFakeApi(appHandlers({ 'factory:list': () => withTitle }));
    const api = (window as unknown as { api: { invoke: unknown } }).api;
    expect(api).toBeDefined();

    render(<App />);
    const [entry] = await screen.findAllByRole('button', { name: /invest-track/ });
    await userEvent.setup().click(entry!);

    expect(await screen.findByText('Professional redesign of the frontend')).toBeTruthy();
    expect(screen.getByText(/f0042/)).toBeTruthy();
    expect(screen.queryByText('Untitled run')).toBeNull();
  });

  it('shows a run from before titles existed by its first sentence', async () => {
    installFakeApi(appHandlers({ 'factory:list': () => listOf([RUN.round1]) }));
    render(<App />);
    const [entry] = await screen.findAllByRole('button', { name: /invest-track/ });
    await userEvent.setup().click(entry!);

    expect(await screen.findByText('I want to do a big refactor on the UI for this repository')).toBeTruthy();
    expect(screen.queryByText('Untitled run')).toBeNull();
  });

  it('keeps a rename: stored through the main process, and still there after switching repository', async () => {
    const titles: Record<string, string> = {};
    const api = installFakeApi(
      appHandlers({
        'factory:list': () => listOf([RUN.round1]).map((run) => ({ ...run, title: titles[run.runId] ?? 'Professional redesign of the frontend' })),
        'factory:rename-run': (runId: string, title: string) => {
          titles[runId] = title;
        },
      }),
    );
    const user = await openRepository(api);

    await user.dblClick(await screen.findByText('Professional redesign of the frontend'));
    const box = screen.getByDisplayValue('Professional redesign of the frontend');
    await user.clear(box);
    await user.type(box, 'Phase one: tokens and dark mode{Enter}');

    expect(await screen.findByText('Phase one: tokens and dark mode')).toBeTruthy();
    expect(api.callsTo('factory:rename-run')).toEqual([[RUN.round1, 'Phase one: tokens and dark mode']]);

    // The list is read from the store again (switching repository does exactly that) and the name is still there.
    api.emit('factory:started', RUN.round1);
    await waitFor(() => expect(api.callsTo('factory:list').length).toBeGreaterThan(1));
    expect(await screen.findByText('Phase one: tokens and dark mode')).toBeTruthy();
  });

  it('puts the name back, and says why, when the store refuses the rename', async () => {
    const api = installFakeApi(
      appHandlers({
        'factory:list': () => listOf([RUN.round1]).map((run) => ({ ...run, title: 'Professional redesign of the frontend' })),
        'factory:rename-run': () => {
          throw new Error('This run has no record to rename.');
        },
      }),
    );
    const user = await openRepository(api);

    await user.dblClick(await screen.findByText('Professional redesign of the frontend'));
    const box = screen.getByDisplayValue('Professional redesign of the frontend');
    await user.clear(box);
    await user.type(box, 'Something else{Enter}');

    expect(await screen.findByText(/Rename failed: .*no record to rename/)).toBeTruthy();
    expect(screen.getByText('Professional redesign of the frontend')).toBeTruthy();
  });
});

describe('a round that starts by itself', () => {
  it('appears in the history as soon as its process names it, without switching repository', async () => {
    let runs = listOf([RUN.round1]);
    const api = installFakeApi(appHandlers({ 'factory:list': () => runs }));
    await openRepository(api);
    await screen.findByText(/I want to do a big refactor/);
    expect(screen.queryByText(/Round 2 of this task/)).toBeNull();

    // The watcher starts round 2: its process prints the run id, and the main process says so.
    runs = listOf([RUN.round1, RUN.round2], [RUN.round2]);
    api.emit('factory:started', RUN.round2);

    expect(await screen.findByText(/Round 2 of this task/)).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
  });
});

describe('leaving a run that is still going', () => {
  it('is possible: a way back to the history is always there, and the run carries on', async () => {
    const api = installFakeApi(
      appHandlers({
        'factory:list': () => listOf([RUN.round1, RUN.round2], [RUN.round2]),
        ...openingARun([RUN.round1, RUN.round2], [RUN.round2]),
      }),
    );
    const user = await openRepository(api);

    // Open the running round from the history.
    const roundRow = (await screen.findByText(/Round 2 of this task/)).closest('div[class*="cursor-pointer"]') as HTMLElement;
    await user.click(within(roundRow).getByText(/20261019-173458-invest-track-c0u4/));

    const breadcrumb = await screen.findByTestId('run-breadcrumb');
    expect(within(breadcrumb).getByRole('button', { name: /Run history/ })).toBeTruthy();

    await user.click(within(breadcrumb).getByRole('button', { name: /Run history/ }));

    // Back on the history, the running round is listed as running, and it was not stopped.
    expect(await screen.findByText('Running')).toBeTruthy();
    expect(api.callsTo('factory:cancel')).toEqual([]);
  });

  it('does not let a task that works in the user\'s repository start while another one uses it', async () => {
    const api = installFakeApi(
      appHandlers({
        'factory:list': () => listOf([RUN.round1, RUN.round2], [RUN.round2]), // round 2 is going; the real runs worked in the repository
      }),
    );
    const user = await openRepository(api);

    await user.click(await screen.findByRole('radio', { name: /My repository/ }));

    const notice = await screen.findByTestId('task-blocked');
    expect(notice.textContent).toContain('is still running in this repository');
    expect(notice.textContent).toContain('uses the same working copy');
    expect(notice.textContent).toContain('choose an isolated worktree to start it now');

    await user.type(screen.getByPlaceholderText(/Describe your next task/), 'Another task entirely');
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.callsTo('factory:run-task')).toEqual([]);
  });

  it('starts a task in a checkout of its own meanwhile - it does not use the repository the other one is using', async () => {
    const api = installFakeApi(
      appHandlers({
        'factory:list': () => listOf([RUN.round1, RUN.round2], [RUN.round2]),
        'factory:run-task': () => new Promise(() => {}),
      }),
    );
    const user = await openRepository(api);

    await screen.findByText(/Round 2 of this task/);
    expect(screen.queryByTestId('task-blocked')).toBeNull(); // the default is an isolated worktree
    await user.type(screen.getByPlaceholderText(/Describe your next task/), 'Another task entirely');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(api.callsTo('factory:run-task').length).toBe(1));
    expect(api.callsTo('factory:run-task')[0]![0]).toMatchObject({ task: 'Another task entirely', isolation: 'worktree', phasing: 'auto' });
  });

  it('is not held up by a run that works in a checkout of its own, even when it chooses to work in the repository', async () => {
    const inItsOwnCheckout = listOf([RUN.round1, RUN.round2], [RUN.round2]).map((run) => ({ ...run, isolation: 'worktree' as const, workPath: '/home/dev/workspace/.factory/worktrees/invest-track/f0042' }));
    const api = installFakeApi(appHandlers({ 'factory:list': () => inItsOwnCheckout }));
    const user = await openRepository(api);

    await user.click(await screen.findByRole('radio', { name: /My repository/ }));

    await screen.findByText(/Round 2 of this task/);
    expect(screen.queryByTestId('task-blocked')).toBeNull();
  });

  it('lets a task start when nothing is running there', async () => {
    const api = installFakeApi(
      appHandlers({
        'factory:list': () => listOf([RUN.round1, RUN.round2]),
        'factory:run-task': () => new Promise(() => {}),
      }),
    );
    const user = await openRepository(api);

    await screen.findByText(/I want to do a big refactor/);
    expect(screen.queryByTestId('task-blocked')).toBeNull();
    await user.type(screen.getByPlaceholderText(/Describe your next task/), 'Another task entirely');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(api.callsTo('factory:run-task').length).toBe(1));
    expect(api.callsTo('factory:run-task')[0]![0]).toMatchObject({ repo: 'invest-track', repoPath: REPO_PATH, task: 'Another task entirely' });
  });
});

describe('tabs', () => {
  it('moves to another open repository when the active one is closed, even when it was the first tab', async () => {
    installFakeApi(
      appHandlers({
        'factory:list-repos': () => [
          { name: 'invest-track', path: REPO_PATH, recentRuns: 0 },
          { name: 'other-repo', path: '/home/dev/workspace/other-repo', recentRuns: 0 },
        ],
        'factory:list': () => [],
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click((await screen.findAllByRole('button', { name: /^invest-track/ }))[0]!);
    await user.click((await screen.findAllByRole('button', { name: /^other-repo/ }))[0]!);
    expect(await screen.findByText(/New Task for other-repo/)).toBeTruthy();

    // Make the first tab the active one, then close it.
    const closeFirst = screen.getByRole('button', { name: 'Close invest-track' });
    await user.click(closeFirst.parentElement!);
    expect(await screen.findByText(/New Task for invest-track/)).toBeTruthy();
    await user.click(closeFirst);

    expect(await screen.findByText(/New Task for other-repo/)).toBeTruthy();
    expect(screen.queryByText(/New Task for invest-track/)).toBeNull();
  });
});
