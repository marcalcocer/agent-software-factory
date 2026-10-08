/**
 * Git and GitHub tools.
 *
 * Read operations (status, diff, log, branch) are available to every agent.
 * Write operations (branch creation, commit, push, pull request) are only used by the
 * dedicated workflow steps and are gated by configuration flags, so an agent can never
 * publish anything on its own initiative.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { getFactoryConfig, resolveRepoPath } from '../utils/factory-config.ts';
import { hasExecutable, runGit, runProcess, type CommandResult } from '../utils/shell.ts';

/** Validates a repository reference coming from an agent (keeps it inside the workspace). */
function repo(repoPath: string): string {
  return resolveRepoPath(repoPath, { requireGit: true });
}

function fail(result: CommandResult): string {
  return `git ${result.args.join(' ')} failed (exit ${result.exitCode}): ${
    result.stderr.trim() || result.stdout.trim()
  }`;
}

/* -------------------------------------------------------------------------- */
/* Plain helpers (used by workflow steps)                                      */
/* -------------------------------------------------------------------------- */

export async function getCurrentBranch(repoPath: string): Promise<string> {
  const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
  if (!result.ok) throw new Error(fail(result));
  return result.stdout.trim();
}

export async function isWorkingTreeClean(repoPath: string): Promise<boolean> {
  const result = await runGit(['status', '--porcelain'], { cwd: repoPath });
  if (!result.ok) throw new Error(fail(result));
  return result.stdout.trim() === '';
}

export async function createBranch(
  repoPath: string,
  branchName: string,
  baseBranch?: string,
): Promise<{ created: boolean; branch: string; baseBranch: string }> {
  const base = baseBranch ?? (await getCurrentBranch(repoPath));
  const existing = await runGit(['rev-parse', '--verify', `refs/heads/${branchName}`], {
    cwd: repoPath,
  });

  if (existing.ok) {
    const checkout = await runGit(['checkout', branchName], { cwd: repoPath });
    if (!checkout.ok) throw new Error(fail(checkout));
    return { created: false, branch: branchName, baseBranch: base };
  }

  const result = await runGit(['checkout', '-b', branchName, base], { cwd: repoPath });
  if (!result.ok) throw new Error(fail(result));
  return { created: true, branch: branchName, baseBranch: base };
}

export async function getDiff(
  repoPath: string,
  options: { baseRef?: string; staged?: boolean; nameOnly?: boolean; maxChars?: number } = {},
): Promise<{ diff: string; truncated: boolean; files: string[] }> {
  const args = ['--no-pager', 'diff'];
  if (options.staged) args.push('--cached');
  if (options.baseRef) args.push(`${options.baseRef}...HEAD`);
  if (options.nameOnly) args.push('--name-only');

  const [diffResult, untrackedResult] = await Promise.all([
    runGit([...args], { cwd: repoPath }),
    runGit(['ls-files', '--others', '--exclude-standard'], { cwd: repoPath }),
  ]);
  if (!diffResult.ok) throw new Error(fail(diffResult));

  const maxChars = options.maxChars ?? getFactoryConfig().maxOutputChars * 2;
  const raw = diffResult.stdout;
  const truncated = raw.length > maxChars;
  const untracked = untrackedResult.stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const nameStatus = await runGit(['--no-pager', 'diff', '--name-only'], { cwd: repoPath });

  return {
    diff: truncated
      ? `${raw.slice(0, maxChars)}\n\n[... diff truncated at ${maxChars} characters ...]`
      : raw,
    truncated,
    files: [
      ...nameStatus.stdout.split('\n').map((entry) => entry.trim()).filter(Boolean),
      ...untracked,
    ],
  };
}

export async function commitAll(
  repoPath: string,
  message: string,
): Promise<{ committed: boolean; sha: string | null; reason?: string }> {
  if (await isWorkingTreeClean(repoPath)) {
    return { committed: false, sha: null, reason: 'Working tree is clean: nothing to commit.' };
  }
  const add = await runGit(['add', '-A'], { cwd: repoPath });
  if (!add.ok) throw new Error(fail(add));

  const commit = await runGit(['commit', '-m', message], { cwd: repoPath });
  if (!commit.ok) throw new Error(fail(commit));

  const sha = await runGit(['rev-parse', 'HEAD'], { cwd: repoPath });
  return { committed: true, sha: sha.ok ? sha.stdout.trim() : null };
}

export async function pushBranch(
  repoPath: string,
  branch: string,
): Promise<{ pushed: boolean; reason?: string }> {
  if (!getFactoryConfig().allowPush) {
    return { pushed: false, reason: 'Push disabled (FACTORY_ALLOW_PUSH=false).' };
  }
  const remotes = await runGit(['remote'], { cwd: repoPath });
  if (!remotes.ok || remotes.stdout.trim() === '') {
    return { pushed: false, reason: 'Repository has no git remote configured.' };
  }
  const result = await runGit(['push', '-u', 'origin', branch], { cwd: repoPath });
  return result.ok
    ? { pushed: true }
    : { pushed: false, reason: fail(result) };
}

export async function createDraftPullRequest(
  repoPath: string,
  options: { title: string; body: string; baseBranch: string; labels?: string[] },
): Promise<{ created: boolean; url: string | null; reason?: string }> {
  if (!getFactoryConfig().allowPullRequest) {
    return { created: false, url: null, reason: 'PR creation disabled (FACTORY_ALLOW_PR=false).' };
  }
  if (!(await hasExecutable('gh', repoPath))) {
    return {
      created: false,
      url: null,
      reason: 'GitHub CLI (`gh`) not found. Install it and run `gh auth login` to open PRs.',
    };
  }

  // The PR body is passed through a temporary file to avoid any shell/argument-size issue.
  const bodyFile = path.join(repoPath, '.git', `factory-pr-body-${Date.now()}.md`);
  fs.writeFileSync(bodyFile, options.body, 'utf8');

  try {
    const args = [
      'pr',
      'create',
      '--draft',
      '--base',
      options.baseBranch,
      '--title',
      options.title,
      '--body-file',
      bodyFile,
    ];
    for (const label of options.labels ?? []) args.push('--label', label);

    const result = await runProcess('gh', args, { cwd: repoPath, trusted: true });
    if (!result.ok) {
      return {
        created: false,
        url: null,
        reason: `gh pr create failed (exit ${result.exitCode}): ${
          result.stderr.trim() || result.stdout.trim()
        }`,
      };
    }
    const url = result.stdout.trim().split('\n').find((line) => line.startsWith('http')) ?? null;
    return { created: true, url };
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* Agent-facing tools                                                         */
/* -------------------------------------------------------------------------- */

export const gitStatusTool = createTool({
  id: 'git-status',
  description:
    'Show the git status of the target repository: current branch, staged/unstaged/untracked ' +
    'files and whether the working tree is clean.',
  inputSchema: z.object({
    repoPath: z.string().describe('Absolute path of the target repository.'),
  }),
  outputSchema: z.object({
    branch: z.string(),
    clean: z.boolean(),
    porcelain: z.string(),
    changedFiles: z.array(z.string()),
  }),
  execute: async ({ repoPath }) => {
    const cwd = repo(repoPath);
    const [branch, status] = await Promise.all([
      getCurrentBranch(cwd),
      runGit(['status', '--porcelain'], { cwd }),
    ]);
    if (!status.ok) throw new Error(fail(status));
    const porcelain = status.stdout;
    return {
      branch,
      clean: porcelain.trim() === '',
      porcelain,
      changedFiles: porcelain
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter(Boolean),
    };
  },
});

export const gitDiffTool = createTool({
  id: 'git-diff',
  description:
    'Show the current changes of the target repository as a unified diff. Use `nameOnly` for a ' +
    'cheap overview first, then request the full diff. Use `baseRef` to compare against a branch.',
  inputSchema: z.object({
    repoPath: z.string(),
    baseRef: z.string().optional().describe('Compare against this ref (e.g. "main").'),
    staged: z.boolean().optional().describe('Diff the staged changes only.'),
    nameOnly: z.boolean().optional().describe('Return only the list of changed files.'),
    maxChars: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    diff: z.string(),
    files: z.array(z.string()),
    truncated: z.boolean(),
  }),
  execute: async ({ repoPath, baseRef, staged, nameOnly, maxChars }) => {
    const options: Parameters<typeof getDiff>[1] = {};
    if (baseRef !== undefined) options.baseRef = baseRef;
    if (staged !== undefined) options.staged = staged;
    if (nameOnly !== undefined) options.nameOnly = nameOnly;
    if (maxChars !== undefined) options.maxChars = maxChars;
    return await getDiff(repo(repoPath), options);
  },
});

export const gitLogTool = createTool({
  id: 'git-log',
  description:
    'Show recent commits of the target repository to understand its history and commit-message ' +
    'conventions.',
  inputSchema: z.object({
    repoPath: z.string(),
    limit: z.number().int().min(1).max(100).default(15),
    filePath: z.string().optional().describe('Restrict the history to one file or folder.'),
  }),
  outputSchema: z.object({ commits: z.array(z.string()) }),
  execute: async ({ repoPath, limit, filePath }) => {
    const args = ['--no-pager', 'log', `-n${limit}`, '--pretty=format:%h %ad %an: %s', '--date=short'];
    if (filePath) args.push('--', filePath);
    const result = await runGit(args, { cwd: repo(repoPath) });
    if (!result.ok) throw new Error(fail(result));
    return { commits: result.stdout.split('\n').filter(Boolean) };
  },
});

export const gitCreateBranchTool = createTool({
  id: 'git-create-branch',
  description:
    'Create (or check out, if it already exists) a work branch in the target repository. ' +
    'Reserved for the factory preparation step.',
  inputSchema: z.object({
    repoPath: z.string(),
    branchName: z.string(),
    baseBranch: z.string().optional(),
  }),
  outputSchema: z.object({
    created: z.boolean(),
    branch: z.string(),
    baseBranch: z.string(),
  }),
  execute: async ({ repoPath, branchName, baseBranch }) =>
    await createBranch(repo(repoPath), branchName, baseBranch),
});

export const gitCommitTool = createTool({
  id: 'git-commit',
  description:
    'Stage every change and create a commit in the target repository. Reserved for the factory ' +
    'delivery step: implementation agents must never commit.',
  inputSchema: z.object({
    repoPath: z.string(),
    message: z.string().describe('Conventional Commits message.'),
  }),
  outputSchema: z.object({
    committed: z.boolean(),
    sha: z.string().nullable(),
    reason: z.string().optional(),
  }),
  execute: async ({ repoPath, message }) => await commitAll(repo(repoPath), message),
});

export const gitPushTool = createTool({
  id: 'git-push',
  description:
    'Push the work branch to `origin` (requires FACTORY_ALLOW_PUSH=true). Reserved for the ' +
    'factory delivery step.',
  inputSchema: z.object({ repoPath: z.string(), branch: z.string() }),
  outputSchema: z.object({ pushed: z.boolean(), reason: z.string().optional() }),
  execute: async ({ repoPath, branch }) => await pushBranch(repo(repoPath), branch),
});

export const gitCreatePullRequestTool = createTool({
  id: 'git-create-pull-request',
  description:
    'Open a DRAFT pull request with the GitHub CLI (requires FACTORY_ALLOW_PR=true and an ' +
    'authenticated `gh`). Reserved for the factory delivery step.',
  inputSchema: z.object({
    repoPath: z.string(),
    title: z.string(),
    body: z.string(),
    baseBranch: z.string(),
    labels: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    created: z.boolean(),
    url: z.string().nullable(),
    reason: z.string().optional(),
  }),
  execute: async ({ repoPath, title, body, baseBranch, labels }) =>
    await createDraftPullRequest(repo(repoPath), {
      title,
      body,
      baseBranch,
      ...(labels === undefined ? {} : { labels }),
    }),
});

/** Read-only git tools, safe for every agent. */
export const gitReadTools = {
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
};

/** Write tools, used by the delivery step only. */
export const gitWriteTools = {
  gitCreateBranchTool,
  gitCommitTool,
  gitPushTool,
  gitCreatePullRequestTool,
};
