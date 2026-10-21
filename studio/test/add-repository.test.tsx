// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import App from '../src/App';
import { appHandlers, installFakeApi } from './support/fake-api';

/** Adding a repository with the folder picker, as the user does: the button next to "Repositories". */
async function addRepository(handlers: Record<string, (...args: any[]) => unknown>) {
  const api = installFakeApi(appHandlers({ 'factory:list': () => [], ...handlers }));
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByTitle('Add repository'));
  return api;
}

describe('adding a repository', () => {
  it('says why a folder was refused, and not in Electron\'s words - nothing is opened', async () => {
    const reason = '/home/dev/notes is not a git repository (it has no .git folder), so the factory cannot work on it. Choose the folder that holds the repository, or run "git init" in this one and make a first commit.';
    const api = await addRepository({
      'repo:browse': () => {
        throw new Error(`Error invoking remote method 'repo:browse': Error: ${reason}`);
      },
    });

    expect(await screen.findByText(`Failed to add repository: ${reason}`)).toBeTruthy();
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
    expect(api.callsTo('factory:list')).toEqual([]); // no repository was opened
  });

  it('says it as an alert, above a screen that has no repository open - that is where a first folder is added', async () => {
    await addRepository({
      'repo:browse': () => {
        throw new Error("Error invoking remote method 'repo:browse': Error: /home/dev/notes is not a git repository (it has no .git folder).");
      },
    });

    const alert = await screen.findByRole('alert');

    expect(alert.textContent).toBe('Failed to add repository: /home/dev/notes is not a git repository (it has no .git folder).');
    expect(screen.getByText('No repository selected')).toBeTruthy(); // nothing is open: the alert is not inside a repository's tab
  });

  it('takes the refusal away when the next folder is a repository', async () => {
    let answers = 0;
    const api = await addRepository({
      'repo:browse': () => {
        answers += 1;
        if (answers === 1) throw new Error('/home/dev/notes is not a git repository (it has no .git folder).');
        return { id: 'invest-track-2', name: 'invest-track-2', path: '/home/dev/projects/invest-track-2' };
      },
    });
    expect(await screen.findByRole('alert')).toBeTruthy();

    await userEvent.setup().click(screen.getByTitle('Add repository'));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.callsTo('repo:browse')).toHaveLength(2);
  });

  it('opens a repository that is not in the workspace like any other - no warning', async () => {
    await addRepository({
      'repo:browse': () => ({ id: 'invest-track-2', name: 'invest-track-2', path: '/home/dev/projects/invest-track-2', lastAccessed: '2026-10-21T12:00:00.000Z' }),
    });

    await waitFor(() => expect(screen.getAllByText(/invest-track-2/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/Failed to add repository/)).toBeNull();
    expect(screen.queryByText(/outside the/)).toBeNull();
  });
});
