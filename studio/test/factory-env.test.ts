import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { factoryEnvironment, knownRepositories } from '../electron/services/factory-env';

let world: string;
beforeEach(() => {
  world = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-env-'));
});
afterEach(() => fs.rmSync(world, { recursive: true, force: true }));

/** A logs folder with one record per run, as the factory writes them. */
function logsOf(...runs: Array<{ id: string; repository?: string; raw?: string }>): string {
  const logs = path.join(world, 'logs');
  for (const run of runs) {
    fs.mkdirSync(path.join(logs, run.id), { recursive: true });
    fs.writeFileSync(path.join(logs, run.id, 'summary.json'), run.raw ?? JSON.stringify({ repository: run.repository }));
  }
  fs.mkdirSync(logs, { recursive: true });
  return logs;
}

describe('knownRepositories', () => {
  it('lists what the user added first, then what runs were made on, with how many runs each has', () => {
    const logs = logsOf(
      { id: 'r1', repository: '/w/billing' },
      { id: 'r2', repository: '/w/billing' },
      { id: 'r3', repository: '/projects/invest-track' },
    );

    expect(knownRepositories({ saved: [{ name: 'demo-app', path: '/w/demo-app' }], logsDir: logs })).toEqual([
      { name: 'billing', path: '/w/billing', recentRuns: 2 },
      { name: 'invest-track', path: '/projects/invest-track', recentRuns: 1 },
      { name: 'demo-app', path: '/w/demo-app', recentRuns: 0 },
    ]);
  });

  it('counts a run on a repository that was added as a run of that one, and keeps where it was added', () => {
    const logs = logsOf({ id: 'r1', repository: '/elsewhere/invest-track' });

    expect(knownRepositories({ saved: [{ name: 'invest-track', path: '/projects/invest-track' }], logsDir: logs })).toEqual([
      { name: 'invest-track', path: '/projects/invest-track', recentRuns: 1 },
    ]);
  });

  it('skips a record it cannot read, a folder that is not a run, and a logs folder that is not there', () => {
    const logs = logsOf({ id: 'good', repository: '/w/app' }, { id: 'broken', raw: '{not json' }, { id: 'nameless', raw: '{}' });
    fs.mkdirSync(path.join(logs, 'not-a-run'));
    fs.writeFileSync(path.join(logs, 'stray-file.txt'), 'x');

    expect(knownRepositories({ logsDir: logs })).toEqual([{ name: 'app', path: '/w/app', recentRuns: 1 }]);
    expect(knownRepositories({ logsDir: path.join(world, 'nowhere') })).toEqual([]);
  });
});

describe('factoryEnvironment', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/dev', FACTORY_LOG_DIR: '/var/logs' };

  it('tells the factory which repositories were opened, as a list separated like PATH', () => {
    const env = factoryEnvironment({ base, repositories: ['/projects/invest-track', '/w/demo-app'] });

    expect(env.FACTORY_EXTRA_REPOS).toBe(['/projects/invest-track', '/w/demo-app'].join(path.delimiter));
  });

  it('keeps the rest of the environment as it was, and does not change the one it was given', () => {
    const given = { ...base };

    const env = factoryEnvironment({ base: given, repositories: ['/projects/a'] });

    expect(env).toMatchObject(base);
    expect(given).toEqual(base);
  });

  it('adds to a list the Studio was started with, without repeating a repository', () => {
    const env = factoryEnvironment({ base: { ...base, FACTORY_EXTRA_REPOS: ['/mine/one', '/projects/a'].join(path.delimiter) }, repositories: ['/projects/a', '/projects/b'] });

    expect(env.FACTORY_EXTRA_REPOS).toBe(['/mine/one', '/projects/a', '/projects/b'].join(path.delimiter));
  });

  it('sets nothing when no repository was opened - and leaves a list it was started with alone', () => {
    expect('FACTORY_EXTRA_REPOS' in factoryEnvironment({ base, repositories: [] })).toBe(false);
    expect(factoryEnvironment({ base: { ...base, FACTORY_EXTRA_REPOS: '/mine/one' }, repositories: [] }).FACTORY_EXTRA_REPOS).toBe('/mine/one');
  });

  it('leaves out what the factory could not read back from the list: a relative path, and one with the separator in it', () => {
    const env = factoryEnvironment({ base, repositories: ['relative/app', `/odd${path.delimiter}name/app`, '/projects/ok'] });

    expect(env.FACTORY_EXTRA_REPOS).toBe('/projects/ok');
  });

  it('lets the caller decide the rest: its overrides win', () => {
    const env = factoryEnvironment({ base: { ...base, FACTORY_PROVIDER: 'api' }, repositories: [], overrides: { FACTORY_PROVIDER: 'claude-cli', FACTORY_NON_INTERACTIVE: 'true' } });

    expect(env).toMatchObject({ FACTORY_PROVIDER: 'claude-cli', FACTORY_NON_INTERACTIVE: 'true' });
  });
});

/* -------------------------------------------------------------------------- */
/* The contract with the real factory                                          */
/* -------------------------------------------------------------------------- */

describe('what the real factory makes of it', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  /** Runs the factory CLI as the Studio does - system node, tsx, the factory folder - and returns the payload of its marker line. */
  function ask(env: NodeJS.ProcessEnv, args: string[], marker: string): { error?: string; repoPath?: string } {
    // A command that answers with an error exits with 1 - and still prints its marker line, which is what is read.
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/.bin/tsx'), path.join(root, 'factory/src/cli/factory.ts'), ...args], {
      env,
      cwd: path.join(root, 'factory'),
      encoding: 'utf8',
    });
    const line = result.stdout.split('\n').find((candidate) => candidate.startsWith(`${marker} `));
    if (!line) throw new Error(`The factory printed no ${marker}:\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(line.slice(marker.length + 1));
  }

  function repository(...parts: string[]): string {
    const folder = path.join(world, ...parts);
    fs.mkdirSync(folder, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: folder });
    return folder;
  }

  it('opens a repository that is not in the workspace once the Studio lists it - and still refuses one it does not', () => {
    const workspace = path.join(world, 'workspace');
    fs.mkdirSync(workspace);
    const opened = repository('projects', 'invest-track');
    const stranger = repository('projects', 'stranger');
    const minimal = { PATH: process.env.PATH, HOME: process.env.HOME, FACTORY_WORKSPACE_ROOT: workspace, FACTORY_LOG_DIR: path.join(world, 'logs') };

    // What happened to the user: the repository was opened in the Studio, the factory was told nothing.
    const untold = ask(factoryEnvironment({ base: minimal, repositories: [] }), ['initiative-list', '--repo', opened], 'INITIATIVE_LIST_JSON');
    expect(untold.error).toContain('is outside the places the factory may work in');

    const told = factoryEnvironment({ base: minimal, repositories: [opened] });
    expect(ask(told, ['initiative-list', '--repo', opened], 'INITIATIVE_LIST_JSON')).toMatchObject({ repoPath: opened });
    expect(ask(told, ['initiative-list', '--repo', opened], 'INITIATIVE_LIST_JSON').error).toBeUndefined();
    expect(ask(told, ['initiative-list', '--repo', stranger], 'INITIATIVE_LIST_JSON').error).toContain('is outside the places the factory may work in');
  }, 60_000);
});

describe('every factory process of the Studio gets that environment', () => {
  it('is started with cliEnv(), never with the Studio\'s own environment as it is', () => {
    // The bug this prevents: a process started with `...process.env` is never told which repositories were opened,
    // and refuses the very repository the user just added. There are several places that start one.
    const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../electron/ipc');
    for (const file of fs.readdirSync(folder).filter((name) => name.endsWith('.ts'))) {
      expect(fs.readFileSync(path.join(folder, file), 'utf8'), `${file}: start the factory with cliEnv(), not ...process.env`).not.toMatch(/\.\.\.process\.env/);
    }
  });
});
