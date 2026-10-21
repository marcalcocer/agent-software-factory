import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commandPlaces } from '../src/cli/worktrees.ts';

/** Runs the command, and returns its exit code and the marker lines it printed. */
async function ask() {
  const out: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true));
  try {
    const code = await commandPlaces();
    const lines = out.join('').split('\n').filter((line) => line.startsWith('PLACES_JSON '));
    return { code, lines, payload: lines[0] ? JSON.parse(lines[0].slice('PLACES_JSON '.length)) : null };
  } finally {
    stdout.mockRestore();
  }
}

const home = os.homedir();

beforeEach(() => {
  vi.stubEnv('FACTORY_WORKSPACE_ROOT', path.join(home, 'projects'));
  vi.stubEnv('FACTORY_WORKTREES_DIR', '');
  vi.stubEnv('FACTORY_EXTRA_REPOS', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('places', () => {
  it('prints one marker line and succeeds', async () => {
    const { code, lines } = await ask();

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
  });

  it('says where the factory works: the workspace, the checkouts inside it by default, nothing opened on purpose', async () => {
    const { payload } = await ask();

    expect(payload).toEqual({
      workspaceRoot: path.join(home, 'projects'),
      worktreesDir: path.join(home, 'projects', '.factory', 'worktrees'),
      extraRepositories: [],
      volatile: false,
    });
  });

  it('follows what the user set: the checkouts folder, and the repositories opened on purpose', async () => {
    vi.stubEnv('FACTORY_WORKTREES_DIR', path.join(home, 'checkouts'));
    vi.stubEnv('FACTORY_EXTRA_REPOS', [path.join(home, 'elsewhere', 'invest-track'), path.join(home, 'other', 'app')].join(path.delimiter));

    const { payload } = await ask();

    expect(payload).toMatchObject({
      worktreesDir: path.join(home, 'checkouts'),
      extraRepositories: [path.join(home, 'elsewhere', 'invest-track'), path.join(home, 'other', 'app')],
      volatile: false,
    });
  });

  it('warns when the checkouts would be kept where a restart clears them', async () => {
    vi.stubEnv('FACTORY_WORKSPACE_ROOT', path.join(os.tmpdir(), 'a-demo', 'workspace'));

    const { payload } = await ask();

    expect(payload.worktreesDir).toBe(path.join(os.tmpdir(), 'a-demo', 'workspace', '.factory', 'worktrees'));
    expect(payload.volatile).toBe(true);
  });

  it('judges the folder the checkouts are in, not the workspace: a workspace in /tmp with checkouts kept elsewhere is fine', async () => {
    vi.stubEnv('FACTORY_WORKSPACE_ROOT', path.join(os.tmpdir(), 'a-demo', 'workspace'));
    vi.stubEnv('FACTORY_WORKTREES_DIR', path.join(home, 'checkouts'));

    expect((await ask()).payload.volatile).toBe(false);
  });
});
