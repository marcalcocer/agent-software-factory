import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A `gh` that talks to a file instead of GitHub, so the real code that calls it can run.
 *
 * It answers the calls the factory makes about one pull request - view, review threads, merge, branch
 * deletion - from a state file the test edits, and a merge changes that state to MERGED the way GitHub
 * would. Every call is logged. Put `bin` first on PATH.
 */
export interface PullRequestState {
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  title: string;
  url: string;
  headBranch: string;
  baseBranch: string;
  /** The commit the branch is at on GitHub: a merge is bound to it. */
  headSha: string;
  mergeCommit: string;
  /** Make `gh pr merge` fail with this message. */
  mergeFails?: string;
  /** Make `gh pr view` fail with this message (a pull request that is gone). */
  viewFails?: string;
  /** Review comments, as the factory reads them. */
  comments: Array<{ id: string; author: { login: string } | null; body: string; createdAt: string }>;
}

const SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_GH_STATE;
const logFile = process.env.FAKE_GH_LOG;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
fs.appendFileSync(logFile, JSON.stringify(args) + '\\n');
const out = (value) => { process.stdout.write(JSON.stringify(value) + '\\n'); process.exit(0); };
const fail = (message, code = 1) => { process.stderr.write(message + '\\n'); process.exit(code); };

if (args[0] === '--version') { process.stdout.write('gh version 2.0.0 (fake)\\n'); process.exit(0); }

if (args[0] === 'repo' && args[1] === 'view') out({ owner: { login: 'o' }, name: 'app' });

if (args[0] === 'pr' && args[1] === 'view') {
  if (state.viewFails) fail(state.viewFails);
  out({
    number: state.number, title: state.title, state: state.state, url: state.url, body: 'The description.',
    headRefName: state.headBranch, baseRefName: state.baseBranch, headRefOid: state.headSha,
    isDraft: false, isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '',
    statusCheckRollup: [], comments: state.comments, reviews: [],
    commits: [{ oid: state.headSha, messageHeadline: state.title, messageBody: '' }],
    files: [{ path: 'src/a.js', additions: 1, deletions: 0 }], additions: 1, deletions: 0,
    mergedAt: state.state === 'MERGED' ? '2026-10-20T10:00:00Z' : null,
    mergeCommit: state.state === 'MERGED' ? { oid: state.mergeCommit } : null,
  });
}

if (args[0] === 'pr' && args[1] === 'list') out([]);

if (args[0] === 'pr' && args[1] === 'merge') {
  if (state.mergeFails) fail(state.mergeFails);
  state.state = 'MERGED';
  fs.writeFileSync(stateFile, JSON.stringify(state));
  process.exit(0);
}

if (args[0] === 'api' && args[1] === 'graphql') out({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
if (args[0] === 'api' && args.includes('DELETE')) process.exit(0);

fail('fake gh: unexpected call ' + JSON.stringify(args), 3);
`;

export interface FakeGh {
  /** Put this first on PATH. */
  bin: string;
  /** What GitHub "says" about the pull request: edit with `set`. */
  state: () => PullRequestState;
  set: (patch: Partial<PullRequestState>) => void;
  /** The calls made, as argument lists. */
  calls: () => string[][];
  /** Prepend `bin` to PATH and point the script at its files. Returns a function that undoes it. */
  install: () => () => void;
  cleanup: () => void;
}

export function createFakeGh(initial: Partial<PullRequestState> & Pick<PullRequestState, 'headBranch' | 'headSha'>): FakeGh {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
  const bin = path.join(dir, 'bin');
  const stateFile = path.join(dir, 'state.json');
  const logFile = path.join(dir, 'calls.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), SCRIPT, { mode: 0o755 });
  fs.writeFileSync(logFile, '');

  const write = (state: PullRequestState) => fs.writeFileSync(stateFile, JSON.stringify(state));
  write({
    number: 8,
    state: 'OPEN',
    title: 'Add a greeting helper',
    url: 'https://github.com/o/app/pull/8',
    baseBranch: 'main',
    mergeCommit: 'c'.repeat(40),
    comments: [],
    ...initial,
  });

  const read = (): PullRequestState => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return {
    bin,
    state: read,
    set: (patch) => write({ ...read(), ...patch }),
    calls: () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]),
    install: () => {
      const saved = { PATH: process.env.PATH, FAKE_GH_STATE: process.env.FAKE_GH_STATE, FAKE_GH_LOG: process.env.FAKE_GH_LOG };
      process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`;
      process.env.FAKE_GH_STATE = stateFile;
      process.env.FAKE_GH_LOG = logFile;
      return () => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      };
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
