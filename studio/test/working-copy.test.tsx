// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RUN } from '../../fixtures';
import { PipelineView } from '../src/components/PipelineView';
import { WorkingCopyBar, WorkingCopyLine } from '../src/components/WorkingCopy';
import type { WorktreeInfo } from '../shared/types';
import { installFakeApi, openingARun } from './support/fake-api';

const CHECKOUT = '/home/dev/workspace/.factory/worktrees/invest-track/f0042';
const BRANCH = 'factory/f0042/feat-dark-mode';

const checkout = (over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  runId: 'R1', isolation: 'worktree', path: CHECKOUT, branch: BRANCH, exists: true, changedFiles: 0, ...over,
});

afterEach(() => vi.unstubAllGlobals());

/** What the platform's clipboard receives. Call it AFTER `userEvent.setup()`, which installs a clipboard of its own. */
const clipboard = () => {
  const writes: string[] = [];
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async (text: string) => void writes.push(text) } });
  return writes;
};

describe('where a task works - on the run screen', () => {
  it('says "Isolated worktree" and shows the folder and the branch, so the code can be looked at by hand', async () => {
    installFakeApi({ 'worktree:info': () => checkout() });

    render(<WorkingCopyBar runId="R1" />);

    expect(await screen.findByTestId('work-mode')).toHaveProperty('textContent', 'Isolated worktree');
    expect(screen.getByTestId('work-path').textContent).toBe(CHECKOUT);
    expect(screen.getByTestId('work-branch').textContent).toBe(BRANCH);
  });

  it('says "Your repository" for a task that worked there, without offering to remove it or move it', async () => {
    installFakeApi({ 'worktree:info': () => checkout({ isolation: 'in-place', path: '/home/dev/workspace/invest-track' }) });

    render(<WorkingCopyBar runId="R1" />);

    expect(await screen.findByTestId('work-mode')).toHaveProperty('textContent', 'Your repository');
    expect(screen.getByTestId('work-path').textContent).toBe('/home/dev/workspace/invest-track');
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open folder' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove worktree' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check out here' })).toBeNull();
  });

  it('copies the path', async () => {
    installFakeApi({ 'worktree:info': () => checkout() });
    const user = userEvent.setup();
    const written = clipboard();
    render(<WorkingCopyBar runId="R1" />);

    await user.click(await screen.findByRole('button', { name: 'Copy path' }));

    expect(written).toEqual([CHECKOUT]);
    expect((await screen.findByTestId('work-notice')).textContent).toBe('Path copied.');
  });

  it('says so, and shows the path, when the platform will not copy', async () => {
    installFakeApi({ 'worktree:info': () => checkout() });
    const user = userEvent.setup();
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async () => Promise.reject(new Error('denied')) } });
    render(<WorkingCopyBar runId="R1" />);

    await user.click(await screen.findByRole('button', { name: 'Copy path' }));

    expect((await screen.findByTestId('work-notice')).textContent).toBe(`Could not copy it. The path is ${CHECKOUT}`);
  });

  it('opens the folder - by run, never by path', async () => {
    const api = installFakeApi({ 'worktree:info': () => checkout(), 'worktree:open': () => undefined });
    const user = userEvent.setup();
    render(<WorkingCopyBar runId="R1" />);

    await user.click(await screen.findByRole('button', { name: 'Open folder' }));

    expect(api.callsTo('worktree:open')).toEqual([['R1']]);
  });

  it('says why the folder could not be opened', async () => {
    installFakeApi({
      'worktree:info': () => checkout(),
      'worktree:open': () => {
        throw new Error("Error invoking remote method 'worktree:open': Error: This folder is not there any more.");
      },
    });
    const user = userEvent.setup();
    render(<WorkingCopyBar runId="R1" />);

    await user.click(await screen.findByRole('button', { name: 'Open folder' }));

    expect((await screen.findByRole('alert')).textContent).toBe('This folder is not there any more.');
  });

  it('shows the files with changes that are not committed - the ones that would be lost by removing it', async () => {
    installFakeApi({ 'worktree:info': () => checkout({ changedFiles: 3 }) });

    render(<WorkingCopyBar runId="R1" />);

    expect((await screen.findByTestId('work-changes')).textContent).toBe('3 files with changes not committed');
  });

  it('says the checkout is gone once it is, and where the work is - without offering what needs the folder', async () => {
    installFakeApi({ 'worktree:info': () => checkout({ exists: false }) });

    render(<WorkingCopyBar runId="R1" />);

    expect(await screen.findByText(/The checkout is gone/)).toBeTruthy();
    expect(screen.getByText(`git checkout ${BRANCH}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove worktree' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check out here' })).toBeNull();
  });

  it('shows nothing for a run it knows nothing about', async () => {
    installFakeApi({ 'worktree:info': () => null });

    const { container } = render(<WorkingCopyBar runId="R1" />);

    await waitFor(() => expect(container.querySelector('[data-testid="working-copy"]')).toBeNull());
  });

  it('shows nothing, and does not break the run screen, when the folder cannot be read', async () => {
    installFakeApi({
      'worktree:info': () => {
        throw new Error('boom');
      },
    });

    const { container } = render(<WorkingCopyBar runId="R1" />);

    await waitFor(() => expect(container.querySelector('[data-testid="working-copy"]')).toBeNull());
  });
});

describe('removing the checkout', () => {
  it('asks first, says the branch stays, and removes it', async () => {
    let info = checkout();
    const api = installFakeApi({
      'worktree:info': () => info,
      'worktree:remove': () => {
        info = checkout({ exists: false });
        return { removed: true };
      },
    });
    const changed = vi.fn();
    const user = userEvent.setup();
    render(<WorkingCopyBar runId="R1" onChanged={changed} />);

    await user.click(await screen.findByRole('button', { name: 'Remove worktree' }));
    expect(api.callsTo('worktree:remove')).toEqual([]); // asked first
    expect(screen.getByText(new RegExp(`The branch ${BRANCH} and everything committed on it stay`))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect((await screen.findByTestId('work-notice')).textContent).toBe(`Removed. The branch ${BRANCH} still has the work.`);
    expect(api.callsTo('worktree:remove')).toEqual([['R1', { force: false }]]);
    expect(changed).toHaveBeenCalled();
    expect(await screen.findByText(/The checkout is gone/)).toBeTruthy(); // the bar looked again
  });

  it('keeps a checkout with uncommitted changes, says why, and removes it only when the user insists', async () => {
    const refusal = 'The checkout at /x has 2 files with changes that are not committed, so it was kept.';
    let forced = false;
    const api = installFakeApi({
      'worktree:info': () => checkout({ changedFiles: 2 }),
      'worktree:remove': (_run: string, options: { force?: boolean }) => {
        forced = options.force === true;
        return forced ? { removed: true } : { removed: false, message: refusal };
      },
    });
    const user = userEvent.setup();
    render(<WorkingCopyBar runId="R1" />);

    await user.click(await screen.findByRole('button', { name: 'Remove worktree' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect((await screen.findByRole('alert')).textContent).toBe(refusal);
    expect(forced).toBe(false);

    // The second question names what would be lost.
    expect(await screen.findByText('Remove it anyway?')).toBeTruthy();
    expect(screen.getByText(/Removing it throws them away/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove and lose the changes' }));

    await waitFor(() => expect(api.callsTo('worktree:remove')).toEqual([['R1', { force: false }], ['R1', { force: true }]]));
  });

  it('changes nothing when the user cancels', async () => {
    const api = installFakeApi({ 'worktree:info': () => checkout(), 'worktree:remove': () => ({ removed: true }) });
    const user = userEvent.setup();
    render(<WorkingCopyBar runId="R1" />);

    await user.click(await screen.findByRole('button', { name: 'Remove worktree' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(api.callsTo('worktree:remove')).toEqual([]);
  });
});

describe('"Check out here"', () => {
  it('explains what it does, and moves the branch to the user\'s repository', async () => {
    let info = checkout();
    const api = installFakeApi({
      'worktree:info': () => info,
      'worktree:checkout': () => {
        info = checkout({ exists: false });
        return { ok: true, branch: BRANCH };
      },
    });
    const user = userEvent.setup();
    render(<WorkingCopyBar runId="R1" />);

    await user.click(await screen.findByRole('button', { name: 'Check out here' }));
    expect(screen.getByText(/removes the task's own folder/)).toBeTruthy();
    expect(screen.getByText(/no uncommitted changes/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Check it out' }));

    expect((await screen.findByTestId('work-notice')).textContent).toBe(`Your repository is now on ${BRANCH}. The task's own folder was removed.`);
    expect(api.callsTo('worktree:checkout')).toEqual([['R1']]);
  });

  it('says why when the factory could not, and the folder is still there', async () => {
    installFakeApi({
      'worktree:info': () => checkout(),
      'worktree:checkout': () => ({ ok: false, error: 'Your repository has changes that are not committed. Commit or stash them, then try again.' }),
    });
    const user = userEvent.setup();
    render(<WorkingCopyBar runId="R1" />);

    await user.click(await screen.findByRole('button', { name: 'Check out here' }));
    await user.click(screen.getByRole('button', { name: 'Check it out' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Your repository has changes that are not committed');
    expect(screen.getByTestId('work-path').textContent).toBe(CHECKOUT);
  });
});

describe('on a pull request', () => {
  it('shows where the code is, with the same two things to do with a path', async () => {
    const api = installFakeApi({ 'worktree:open': () => undefined });
    const user = userEvent.setup();
    const written = clipboard();
    render(<WorkingCopyLine workCopy={{ isolation: 'worktree', path: CHECKOUT, exists: true }} rootRunId="ROOT" />);

    expect(screen.getByTestId('work-mode').textContent).toBe('Isolated worktree');
    expect(screen.getByText(CHECKOUT)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copy path' }));
    await user.click(screen.getByRole('button', { name: 'Open folder' }));

    expect(written).toEqual([CHECKOUT]);
    expect(api.callsTo('worktree:open')).toEqual([['ROOT']]); // the run that opened the pull request
    expect(await screen.findByText('Path copied.')).toBeTruthy();
  });

  it('says a removed checkout comes back when a round needs it, and offers no folder to open', () => {
    installFakeApi({});
    render(<WorkingCopyLine workCopy={{ isolation: 'worktree', path: CHECKOUT, exists: false }} rootRunId="ROOT" />);

    expect(screen.getByText('(removed - made again when a round needs it)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull();
  });

  it('says "Your repository" for a pull request whose task worked there', () => {
    installFakeApi({});
    render(<WorkingCopyLine workCopy={{ isolation: 'in-place', path: '/home/dev/workspace/invest-track', exists: true }} rootRunId="ROOT" />);

    expect(screen.getByTestId('work-mode').textContent).toBe('Your repository');
  });
});

describe('the run screen', () => {
  it('carries the bar: a real run from before checkouts existed shows the repository it worked in', async () => {
    installFakeApi({ ...openingARun([RUN.round1, RUN.round2]) });

    render(<PipelineView runId={RUN.round1} isRunning={false} />);

    expect(await screen.findByTestId('work-mode')).toHaveProperty('textContent', 'Your repository');
    expect(screen.getByTestId('work-path').textContent).toBe('/home/dev/workspace/invest-track');
    expect(screen.getByTestId('work-branch').textContent).toBe('factory/i-want-to-do-a-big-refactor-on-t-61e6');
  });

  it('shows the checkout of a task that worked in one', async () => {
    installFakeApi({
      ...openingARun([RUN.round1, RUN.round2]),
      'worktree:info': (runId: string) => checkout({ runId }),
    });

    render(<PipelineView runId={RUN.round1} isRunning={false} />);

    expect(await screen.findByTestId('work-mode')).toHaveProperty('textContent', 'Isolated worktree');
    expect(screen.getByTestId('work-path').textContent).toBe(CHECKOUT);
  });
});
