// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import App from '../src/App';
import { SettingsPanel } from '../src/components/SettingsPanel';
import type { WorktreeReport } from '../shared/types';
import { appHandlers, idleWatcher, installFakeApi, REPO_PATH } from './support/fake-api';

const global = (over: Record<string, unknown> = {}) => ({
  theme: 'light', workspaceRoot: '/home/dev/workspace', defaultMaxAttempts: 3, dryRunByDefault: false, logLevel: 'info', activeProvider: 'claude-cli', ...over,
});

const checkout = (over: Partial<WorktreeReport> = {}): WorktreeReport => ({
  path: '/home/dev/workspace/.factory/worktrees/invest-track/f0042', taskId: 'f0042', branch: 'factory/f0042/feat-x', exists: true, registered: true, changedFiles: 0,
  title: 'Dark mode for every screen', rootRunId: 'ROOT1', pullRequest: { number: 8, url: 'https://github.com/o/r/pull/8', state: 'OPEN' }, stale: false, ...over,
});

function settings(handlers: Record<string, (...args: any[]) => unknown> = {}, props: Partial<React.ComponentProps<typeof SettingsPanel>> = {}) {
  const api = installFakeApi({
    'settings:get': () => ({ global: global(), repos: {} }),
    'settings:update': () => undefined,
    'pr-watch:get-settings': () => ({ defaults: idleWatcher().settings, repos: {} }),
    'pr-watch:save-settings': () => undefined,
    'factory:list-repos': () => [{ name: 'invest-track', path: REPO_PATH, recentRuns: 1 }],
    ...handlers,
  });
  const onSaved = vi.fn();
  render(<SettingsPanel isOpen onClose={() => {}} onSaved={onSaved} {...props} />);
  return { api, onSaved };
}

describe('where tasks work - the default', () => {
  it('is an isolated worktree unless the user chose otherwise, and says what that means', async () => {
    settings();

    const select = (await screen.findByLabelText('Where tasks work')) as HTMLSelectElement;
    expect(select.value).toBe('worktree');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['An isolated worktree (recommended)', 'My repository']);
    expect(screen.getByText(/your folder is not touched and may have changes/)).toBeTruthy();
  });

  it('shows the one that was saved', async () => {
    settings({ 'settings:get': () => ({ global: global({ isolation: 'in-place' }), repos: {} }) });

    expect(((await screen.findByLabelText('Where tasks work')) as HTMLSelectElement).value).toBe('in-place');
  });

  it('is saved, and the screen is told what to start its forms from', async () => {
    const { api, onSaved } = settings();
    const user = userEvent.setup();

    await user.selectOptions(await screen.findByLabelText('Where tasks work'), 'in-place');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.callsTo('settings:update').length).toBe(1));
    expect((api.callsTo('settings:update')[0]![0] as { global: { isolation: string } }).global.isolation).toBe('in-place');
    expect(onSaved).toHaveBeenCalledWith({ isolation: 'in-place', workspaceRoot: '/home/dev/workspace' });
  });
});

describe('comparing the roadmap with what a phase delivered', () => {
  it('is on unless the user switched it off - a setting from before it existed means yes', async () => {
    settings();

    expect((await screen.findByRole('checkbox', { name: /Compare the roadmap with what a phase delivered/ })) as HTMLInputElement).toHaveProperty('checked', true);
  });

  it('can be switched off, and is saved as off', async () => {
    const { api } = settings();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('checkbox', { name: /Compare the roadmap with what a phase delivered/ }));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.callsTo('settings:update').length).toBe(1));
    expect((api.callsTo('settings:update')[0]![0] as { global: { autoReconcile: boolean } }).global.autoReconcile).toBe(false);
  });

  it('shows the saved choice', async () => {
    settings({ 'settings:get': () => ({ global: global({ autoReconcile: false }), repos: {} }) });

    expect((await screen.findByRole('checkbox', { name: /Compare the roadmap with what a phase delivered/ })) as HTMLInputElement).toHaveProperty('checked', false);
  });
});

describe('the checkouts', () => {
  const open = async (list: WorktreeReport[], extra: Record<string, (...args: any[]) => unknown> = {}) => {
    const harness = settings({ 'worktree:list': () => list, ...extra });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show them' }));
    return { ...harness, user };
  };

  it('is not read until asked: listing means asking git about every checkout', async () => {
    const { api } = settings({ 'worktree:list': () => [] });
    await screen.findByLabelText('Where tasks work');

    expect(api.callsTo('worktree:list')).toEqual([]);
  });

  it('lists them with their task, folder, branch and pull request', async () => {
    const { api } = await open([checkout()]);

    const group = await screen.findByTestId('worktrees-invest-track');
    expect(group.textContent).toContain('Dark mode for every screen');
    expect(group.textContent).toContain('#8 open');
    expect(group.textContent).toContain('/home/dev/workspace/.factory/worktrees/invest-track/f0042');
    expect(group.textContent).toContain('factory/f0042/feat-x');
    expect(api.callsTo('worktree:list')).toEqual([[REPO_PATH]]);
  });

  it('says when there are none', async () => {
    await open([]);

    expect((await screen.findByTestId('worktrees-invest-track')).textContent).toContain('No checkouts.');
  });

  it('warns of work that is not committed, and marks the ones whose pull request is over', async () => {
    await open([checkout({ changedFiles: 2, stale: true, pullRequest: { number: 8, url: 'u', state: 'MERGED' } })]);

    const group = await screen.findByTestId('worktrees-invest-track');
    expect(group.textContent).toContain('2 files not committed');
    expect(group.textContent).toContain('finished');
    expect(group.textContent).toContain('#8 merged');
  });

  it('marks a folder git does not know, and offers no way to remove it', async () => {
    await open([checkout({ registered: false, rootRunId: null })]);

    const group = await screen.findByTestId('worktrees-invest-track');
    expect(group.textContent).toContain('not a checkout git knows - left alone');
    expect(within(group).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('removes one - by its run, never by its path', async () => {
    let list = [checkout()];
    const { api, user } = await open(list, { 'worktree:remove': () => ((list = []), { removed: true }), 'worktree:list': () => list });

    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(api.callsTo('worktree:remove')).toEqual([['ROOT1']]));
    expect((await screen.findByTestId('worktrees-invest-track')).textContent).toContain('No checkouts.');
  });

  it('says why one was kept', async () => {
    const { user } = await open([checkout({ changedFiles: 1 })], {
      'worktree:remove': () => ({ removed: false, message: 'The checkout at /x has 1 file with changes that are not committed, so it was kept.' }),
    });

    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    expect((await screen.findByRole('alert')).textContent).toContain('so it was kept');
  });

  it('cleans up the finished ones, and lists what it kept and why', async () => {
    const stale = checkout({ stale: true, pullRequest: { number: 8, url: 'u', state: 'MERGED' } });
    const { api, user } = await open([stale], {
      'worktree:gc': () => ({ removed: [], kept: [{ path: stale.path, message: 'The checkout at /x has 1 file with changes that are not committed, so it was kept.' }] }),
    });

    await user.click(await screen.findByRole('button', { name: 'Clean up finished' }));

    await waitFor(() => expect(api.callsTo('worktree:gc')).toEqual([[REPO_PATH]]));
    expect((await screen.findByTestId('worktrees-invest-track')).textContent).toContain('so it was kept');
  });

  it('offers no clean-up when nothing is finished', async () => {
    await open([checkout()]);

    await screen.findByTestId('worktrees-invest-track');
    expect(screen.queryByRole('button', { name: 'Clean up finished' })).toBeNull();
  });

  it('says why the list could not be read', async () => {
    const harness = settings({
      'worktree:list': () => {
        throw new Error("Error invoking remote method 'worktree:list': Error: Target repository not found");
      },
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Show them' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Target repository not found');
    void harness;
  });
});

describe('on the whole screen', () => {
  it('a saved default decides what the next task form starts from', async () => {
    let saved = global();
    installFakeApi(
      appHandlers({
        'factory:list': () => [],
        'settings:get': () => ({ global: saved, repos: {} }),
        'settings:update': (update: { global: Record<string, unknown> }) => void (saved = update.global as ReturnType<typeof global>),
        'pr-watch:get-settings': () => ({ defaults: idleWatcher().settings, repos: {} }),
        'pr-watch:save-settings': () => undefined,
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click((await screen.findAllByRole('button', { name: /invest-track/ }))[0]!);
    await screen.findByText(/New Task for invest-track/);
    expect((screen.getByRole('radio', { name: /Isolated worktree/ }) as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.selectOptions(await screen.findByLabelText('Where tasks work'), 'in-place');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect((screen.getByRole('radio', { name: /My repository/ }) as HTMLInputElement).checked).toBe(true));
  });
});
