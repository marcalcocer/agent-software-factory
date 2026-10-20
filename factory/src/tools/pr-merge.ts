/**
 * Merging a pull request the factory opened, on the user's say-so.
 *
 * Two operations, both reached through the CLI (`pr-merge-draft`, `pr-merge`) so the Studio and a
 * terminal behave identically:
 *
 *   draftSquashMessage   reads the pull request and writes the commit message its squash will have
 *                        (an agent reads the NET diff; a plain message is the fallback). Nothing is
 *                        changed anywhere.
 *   mergePullRequest     squash-merges it, then tidies up: deletes the branch and brings the user's
 *                        working copy back to the base branch.
 *
 * What makes the merge safe:
 *   - it is bound to the exact commit the human approved (`--match-head-commit`): if the branch
 *     moved after the approval, GitHub itself refuses;
 *   - everything is re-checked live just before (mergeable, no new review comments), not taken from
 *     what the Studio saw a minute ago;
 *   - what happens AFTER the merge can fail without the merge being reported as failed: once
 *     GitHub has merged, the outcome says "merged" and the notes say what could not be tidied.
 */
import path from 'node:path';

import { mergeSummaryAgent } from '../agents/merge-summary.agent.ts';
import { composePrompt, invokeAgent, promptSection } from '../utils/agent-runner.ts';
import { getFactoryConfig } from '../utils/factory-config.ts';
import { mergeSummarySchema } from '../utils/schemas.ts';
import { runGit, runProcess } from '../utils/shell.ts';
import {
  getCurrentBranch,
  getDefaultBranch,
  isAncestor,
  isWorkingTreeClean,
  recentCommitSubjects,
  refSha,
} from './git-tools.ts';
import { ghJson } from './github-tools.ts';
import { generateRunId, writeArtifact } from './logger-tools.ts';
import {
  assessMerge,
  clipAtWord,
  condenseDiff,
  explainAgentFailure,
  explainMergeFailure,
  fallbackSquashMessage,
  normalizeSquashMessage,
  summarizeChecks,
  type CheckSummary,
  type CondensedDiff,
  type Mergeability,
} from './pr-merge-rules.ts';
import { checkPullRequests } from './pr-watch.ts';
import { settlePullRequest, type SettledPhase } from './pr-lifecycle.ts';
import { pullRequestKey, setPullRequestState } from './pr-registry.ts';

/** `gh` must never wait for a keypress, colour its output or announce updates. */
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };

const short = (sha: string): string => sha.slice(0, 7);
const firstLine = (text: string): string => text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';

/* -------------------------------------------------------------------------- */
/* What GitHub says                                                            */
/* -------------------------------------------------------------------------- */

export interface MergeFacts {
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  mergeable: string;
  mergeState: string;
  reviewDecision: string;
  checks: CheckSummary;
  commits: Array<{ sha: string; headline: string; body: string }>;
  files: Array<{ path: string; additions: number; deletions: number }>;
  additions: number;
  deletions: number;
}

const FACT_FIELDS = [
  'number',
  'url',
  'title',
  'body',
  'state',
  'isDraft',
  'isCrossRepository',
  'headRefName',
  'baseRefName',
  'headRefOid',
  'mergeable',
  'mergeStateStatus',
  'reviewDecision',
  'statusCheckRollup',
  'commits',
  'files',
  'additions',
  'deletions',
].join(',');

interface GhPullRequestFacts {
  number: number;
  url: string;
  title: string;
  body?: string;
  state: string;
  isDraft?: boolean;
  isCrossRepository?: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  statusCheckRollup?: unknown;
  commits?: Array<{ oid: string; messageHeadline: string; messageBody?: string }>;
  files?: Array<{ path: string; additions: number; deletions: number }>;
  additions?: number;
  deletions?: number;
}

export async function fetchMergeFacts(repoPath: string, number: number): Promise<MergeFacts> {
  const pr = await ghJson<GhPullRequestFacts>(repoPath, ['pr', 'view', String(number), '--json', FACT_FIELDS]);
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    body: pr.body ?? '',
    state: pr.state,
    isDraft: pr.isDraft === true,
    isCrossRepository: pr.isCrossRepository === true,
    headBranch: pr.headRefName,
    baseBranch: pr.baseRefName,
    headSha: pr.headRefOid,
    mergeable: pr.mergeable ?? 'UNKNOWN',
    mergeState: pr.mergeStateStatus ?? 'UNKNOWN',
    reviewDecision: pr.reviewDecision ?? '',
    checks: summarizeChecks(pr.statusCheckRollup),
    commits: (pr.commits ?? []).map((commit) => ({
      sha: commit.oid,
      headline: commit.messageHeadline,
      body: commit.messageBody ?? '',
    })),
    files: (pr.files ?? []).map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
  };
}

export const mergeabilityOf = (facts: MergeFacts): Mergeability => ({
  state: facts.state,
  isDraft: facts.isDraft,
  mergeable: facts.mergeable,
  mergeState: facts.mergeState,
  reviewDecision: facts.reviewDecision,
  checks: facts.checks,
  baseBranch: facts.baseBranch,
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GitHub works out "can this be merged?" lazily, so right after a push the answer is UNKNOWN for a
 * few seconds. Ask again a few times before treating that as a reason to stop.
 */
export async function fetchSettledMergeFacts(
  repoPath: string,
  number: number,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<MergeFacts> {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 1500;
  let facts = await fetchMergeFacts(repoPath, number);
  for (let attempt = 1; attempt < attempts && assessMerge(mergeabilityOf(facts)).transient; attempt += 1) {
    await sleep(delayMs);
    facts = await fetchMergeFacts(repoPath, number);
  }
  return facts;
}

/* -------------------------------------------------------------------------- */
/* The draft of the squash message                                             */
/* -------------------------------------------------------------------------- */

export interface SquashDraft {
  subject: string;
  body: string;
  /** `agent`: written by the model from the diff. `fallback`: the pull request's own title and summary. */
  source: 'agent' | 'fallback';
  /** Why the fallback was used, or what the reader should know about the draft. */
  note?: string;
  /** A rehearsal: the AI was deliberately not asked, so asking again would change nothing. */
  dryRun?: boolean;
  pullRequest: { number: number; title: string; url: string; headBranch: string; baseBranch: string; headSha: string };
  stats: { commits: number; files: number; additions: number; deletions: number };
  blockers: string[];
  warnings: string[];
}

/** The net change of the pull request, as GitHub computes it (what the squash will land). */
async function fetchNetDiff(repoPath: string, number: number): Promise<{ text: string; failure?: string }> {
  const result = await runProcess('gh', ['pr', 'diff', String(number), '--color', 'never'], {
    cwd: repoPath,
    trusted: true,
    timeoutMs: 60_000,
    maxOutputChars: 2_000_000,
    env: GH_ENV,
  });
  return result.ok
    ? { text: result.stdout }
    : { text: '', failure: firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.exitCode}` };
}

function buildSquashPrompt(input: {
  facts: MergeFacts;
  diff: CondensedDiff;
  diffFailure: string | undefined;
  recent: string[];
}): string {
  const { facts, diff } = input;

  const commits = facts.commits
    .map((commit) => {
      const body = commit.body.trim();
      return `- ${commit.headline}${body ? `\n${body.split('\n').map((line) => `    ${line}`).join('\n')}` : ''}`;
    })
    .join('\n');
  const files = facts.files.map((file) => `- ${file.path} (+${file.additions} -${file.deletions})`).join('\n');

  const left: string[] = [];
  if (diff.omitted.length > 0) left.push(`Left out of the diff (generated or too large): ${diff.omitted.join(', ')}`);
  if (diff.shortened.length > 0) left.push(`Cut short in the diff: ${diff.shortened.join(', ')}`);
  if (input.diffFailure) left.push(`The diff could not be read (${input.diffFailure}); judge from the file list.`);

  return composePrompt(
    '# Pull request about to be squash-merged',
    '',
    `- Number: #${facts.number}`,
    `- Title: ${facts.title}`,
    `- Branch: ${facts.headBranch} -> ${facts.baseBranch}`,
    promptSection('Description (written before the last rounds - may be out of date)', clipAtWord(facts.body.trim(), 4000)),
    promptSection(`Commits that will be squashed (${facts.commits.length})`, commits),
    promptSection(`Files in the net change (${facts.files.length} files, +${facts.additions} -${facts.deletions})`, files),
    promptSection('Net diff - the source of truth', diff.text),
    promptSection('What you were not shown', left.join('\n')),
    promptSection(`Recent commit subjects on ${facts.baseBranch} (match this style)`, input.recent.map((line) => `- ${line}`).join('\n')),
    '',
    '# Your task',
    '',
    'Write the commit message of the squash: a subject and a body, describing the net result ' +
      'shown by the diff. The pull-request number is added for you.',
  );
}

export async function draftSquashMessage(options: { repoPath: string; number: number }): Promise<SquashDraft> {
  const { repoPath, number } = options;
  const facts = await fetchSettledMergeFacts(repoPath, number);
  const assessment = assessMerge(mergeabilityOf(facts));
  const repoName = path.basename(repoPath);

  const source = {
    number,
    title: facts.title,
    body: facts.body,
    commits: facts.commits.map((commit) => ({ headline: commit.headline })),
    files: facts.files,
  };
  const fallback = fallbackSquashMessage(source);

  const base = {
    pullRequest: {
      number,
      title: facts.title,
      url: facts.url,
      headBranch: facts.headBranch,
      baseBranch: facts.baseBranch,
      headSha: facts.headSha,
    },
    stats: { commits: facts.commits.length, files: facts.files.length, additions: facts.additions, deletions: facts.deletions },
    blockers: assessment.blockers,
    warnings: assessment.warnings,
  };

  const draftOf = (message: { subject: string; body: string }, origin: SquashDraft['source'], note?: string): SquashDraft => ({
    ...message,
    source: origin,
    ...(note ? { note } : {}),
    ...base,
  });

  // The trace of this call (tokens, model) lives under a run id of its own; it is not a run the
  // user sees, so it gets no run.json / summary.json.
  const runId = generateRunId(`${repoName}-merge-${number}`);

  try {
    const diffRequest: Promise<{ text: string; failure?: string }> = getFactoryConfig().dryRun
      ? Promise.resolve({ text: '' })
      : fetchNetDiff(repoPath, number);
    const [net, recent] = await Promise.all([diffRequest, recentCommitSubjects(repoPath, facts.baseBranch)]);
    const diff = condenseDiff(net.text);

    const result = await invokeAgent({
      agent: mergeSummaryAgent,
      role: 'merge-summary',
      step: 'merge-summary',
      runId,
      repoPath,
      repoName,
      prompt: buildSquashPrompt({ facts, diff, diffFailure: net.failure, recent }),
      schema: mergeSummarySchema,
      dryRunResult: { subject: facts.title || fallback.subject, body: fallback.body },
    });

    if (result.dryRun) {
      return { ...draftOf(fallback, 'fallback', "Dry run: the AI was not asked. This is the pull request's own title and summary."), dryRun: true };
    }

    const message = normalizeSquashMessage(result.object, number);
    writeArtifact({
      runId,
      step: 'merge-summary',
      status: 'agent',
      model: result.servedByModel,
      durationMs: result.durationMs,
      data: { pullRequest: number, headSha: facts.headSha, message, omitted: diff.omitted, shortened: diff.shortened },
    });
    const note = net.failure
      ? 'The full diff was not available, so this is based on the list of changed files and the pull request description. Read it carefully.'
      : undefined;
    return draftOf(message, 'agent', note);
  } catch (error) {
    return draftOf(
      fallback,
      'fallback',
      `The AI could not write the message (${explainAgentFailure((error as Error).message)}). ` +
        "This is the pull request's own title and summary instead - edit it if you like.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The merge                                                                   */
/* -------------------------------------------------------------------------- */

export interface MergeOptions {
  repoPath: string;
  number: number;
  /** The commit the human approved. The merge is refused if the branch is no longer at it. */
  expectedHeadSha: string;
  subject: string;
  body: string;
  /** Delete the pull request's branch afterwards (on GitHub, and here when nothing would be lost). */
  deleteBranch: boolean;
  /**
   * Bring the working copy back to the base branch afterwards. The caller knows whether the
   * working copy is free: a run that is still using it must not have its branch switched.
   */
  returnToBase: boolean;
}

export interface MergeOutcome {
  merged: boolean;
  /** Set when nothing was merged because this was a rehearsal. */
  dryRun?: boolean;
  /** Why nothing was merged, in words the user can act on. */
  reason?: string;
  mergeCommit?: string;
  baseBranch?: string;
  headBranch?: string;
  /** What else happened - or deliberately did not - around the merge. */
  notes: string[];
  /** The phase of a project this pull request was, and what comes next in it. */
  phase?: SettledPhase;
}

async function deleteRemoteBranch(repoPath: string, branch: string): Promise<{ ok: boolean; reason?: string }> {
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  const result = await runProcess('gh', ['api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${ref}`], {
    cwd: repoPath,
    trusted: true,
    timeoutMs: 60_000,
    env: GH_ENV,
  });
  if (result.ok) return { ok: true };
  const output = `${result.stderr}\n${result.stdout}`;
  // Already gone (the repository deletes merged branches by itself): that is what was asked for.
  if (/reference does not exist|not found|HTTP 404|HTTP 422/i.test(output)) return { ok: true };
  return { ok: false, reason: firstLine(output) || `exit ${result.exitCode}` };
}

/** Open pull requests that are based on this branch: deleting it would close them. */
async function pullRequestsBasedOn(repoPath: string, branch: string): Promise<number[] | null> {
  try {
    const list = await ghJson<Array<{ number: number }>>(repoPath, [
      'pr', 'list', '--base', branch, '--state', 'open', '--json', 'number',
    ]);
    return list.map((entry) => entry.number);
  } catch {
    return null; // cannot tell: the caller must not delete on a guess
  }
}

/**
 * Brings the user's working copy back to the base branch once the pull request is merged, so the
 * next task does not start from (and stack on) the branch that just became obsolete.
 *
 * Careful on purpose: it only leaves a branch the merge made obsolete, never with uncommitted
 * changes, and never throws away commits that exist nowhere else.
 */
async function tidyWorkingCopy(input: {
  repoPath: string;
  headBranch: string;
  baseBranch: string;
  mergedHeadSha: string;
  allowSwitch: boolean;
  deleteLocalBranch: boolean;
  /** The task worked in a checkout of its own, so the user's branch is deliberately left where it is: say if it is behind. */
  explainUntouched?: boolean;
}): Promise<string[]> {
  const { repoPath, headBranch, baseBranch } = input;
  const notes: string[] = [];

  // Brings in the squash commit and drops the remote-tracking ref of the deleted branch.
  // Touches no branch and no file in the working copy.
  await runGit(['fetch', 'origin', '--prune'], {
    cwd: repoPath,
    env: { GIT_TERMINAL_PROMPT: '0' },
    timeoutMs: 60_000,
  });

  let current: string;
  try {
    current = await getCurrentBranch(repoPath);
  } catch {
    return ['Could not tell which branch your working copy is on, so it was left alone.'];
  }

  if (current === headBranch) {
    if (!input.allowSwitch) {
      notes.push(`Your working copy was left on ${headBranch}: it may be in use by a run that is still going.`);
    } else if (!(await isWorkingTreeClean(repoPath))) {
      notes.push(`Your working copy stays on ${headBranch} because it has uncommitted changes.`);
    } else {
      const checkout = await runGit(['checkout', baseBranch], { cwd: repoPath });
      if (!checkout.ok) {
        notes.push(`Could not switch your working copy to ${baseBranch}: ${firstLine(checkout.stderr)}`);
      } else {
        current = baseBranch;
        const local = await refSha(repoPath, `refs/heads/${baseBranch}`);
        const remote = await refSha(repoPath, `refs/remotes/origin/${baseBranch}`);
        if (local && remote && local !== remote) {
          if (await isAncestor(repoPath, local, remote)) {
            const forward = await runGit(['merge', '--ff-only', `origin/${baseBranch}`], { cwd: repoPath });
            notes.push(
              forward.ok
                ? `Your working copy is back on ${baseBranch}, up to date with GitHub.`
                : `Your working copy is back on ${baseBranch}, but it could not be brought up to date: ${firstLine(forward.stderr)}`,
            );
          } else {
            notes.push(`Your working copy is back on ${baseBranch}. It has commits GitHub does not, so it was not updated.`);
          }
        } else {
          notes.push(`Your working copy is back on ${baseBranch}.`);
        }
      }
    }
  }

  if (input.deleteLocalBranch && current !== headBranch) {
    const tip = await refSha(repoPath, `refs/heads/${headBranch}`);
    if (tip === null) {
      // Nothing local to delete.
    } else if (tip !== input.mergedHeadSha) {
      notes.push(`Kept the local branch ${headBranch}: it has commits that were never pushed.`);
    } else {
      const removed = await runGit(['branch', '-D', headBranch], { cwd: repoPath });
      notes.push(
        removed.ok
          ? `Deleted the local branch ${headBranch}.`
          : `Could not delete the local branch ${headBranch}: ${firstLine(removed.stderr)}`,
      );
    }
  }

  if (input.explainUntouched && current !== headBranch) {
    const local = await refSha(repoPath, `refs/heads/${baseBranch}`);
    const remote = await refSha(repoPath, `refs/remotes/origin/${baseBranch}`);
    if (local && remote && local !== remote && (await isAncestor(repoPath, local, remote))) {
      notes.push(`${baseBranch} on GitHub now has the merged change; your local ${baseBranch} does not yet. Your repository was not touched - pull when you want it.`);
    }
  }

  return notes;
}

export async function mergePullRequest(options: MergeOptions): Promise<MergeOutcome> {
  const { repoPath, number } = options;
  const config = getFactoryConfig();
  const notes: string[] = [];
  const refuse = (reason: string, extra: Partial<MergeOutcome> = {}): MergeOutcome => ({
    merged: false,
    reason,
    notes,
    ...extra,
  });

  const subject = options.subject.trim();
  if (subject === '' || subject.includes('\n')) return refuse('The commit message needs a one-line subject.');
  if (!/^[0-9a-f]{40}$/i.test(options.expectedHeadSha)) {
    return refuse('The approved commit is missing or not a full commit id, so nothing was merged.');
  }
  if (!config.allowPush) return refuse('Merging is switched off here (FACTORY_ALLOW_PUSH=false).');

  // Everything is judged on what GitHub says NOW, not on what the screen showed a minute ago.
  const facts = await fetchSettledMergeFacts(repoPath, number);
  const assessment = assessMerge(mergeabilityOf(facts));
  if (assessment.blockers.length > 0) return refuse(assessment.blockers.join(' '));

  if (facts.headSha.toLowerCase() !== options.expectedHeadSha.toLowerCase()) {
    return refuse(
      `The pull request changed after you approved it: it is now at ${short(facts.headSha)}, and you approved ` +
        `${short(options.expectedHeadSha)}. Review it again, then approve the new version.`,
    );
  }

  // Comments that arrived since the last look. (A pull request the factory did not open is not
  // in its registry, so there is nothing to compare against.)
  const checked = await checkPullRequests({ repoPath, number });
  const entry = checked.pullRequests.find((candidate) => candidate.number === number);
  if (entry?.error) return refuse(`Could not check for new review comments: ${entry.error}`);
  if (entry && entry.pending.length > 0) {
    return refuse(
      `${entry.pending.length === 1 ? 'A review comment has' : `${entry.pending.length} review comments have`} ` +
        'arrived that nobody has dealt with yet. Deal with them before merging.',
    );
  }
  if (!entry) notes.push('This pull request was not opened by the factory, so unhandled review comments were not checked.');

  if (config.dryRun) {
    return refuse(
      `Dry run: nothing was merged. It would have been squashed into ${facts.baseBranch} as "${subject}".`,
      { dryRun: true, baseBranch: facts.baseBranch, headBranch: facts.headBranch },
    );
  }

  const bodyText = options.body.trim();
  const merge = await runProcess(
    'gh',
    [
      'pr', 'merge', String(number),
      '--squash',
      '--subject', subject,
      '--body-file', '-',
      '--match-head-commit', facts.headSha,
    ],
    { cwd: repoPath, trusted: true, timeoutMs: 120_000, stdin: bodyText, env: GH_ENV },
  );
  if (!merge.ok) return refuse(explainMergeFailure(`${merge.stderr}\n${merge.stdout}`, merge.exitCode));

  // From here on it IS merged: nothing below may turn that into a failure.
  let mergeCommit: string | undefined;
  let mergedAt: string | undefined;
  try {
    const after = await ghJson<{ state: string; mergedAt?: string; mergeCommit?: { oid?: string } | null }>(repoPath, [
      'pr', 'view', String(number), '--json', 'state,mergedAt,mergeCommit',
    ]);
    if (after.state !== 'MERGED') {
      return refuse(
        'GitHub accepted the request but has not merged the pull request yet (the repository may use auto-merge ' +
          'or a merge queue). Check it on GitHub.',
      );
    }
    mergeCommit = after.mergeCommit?.oid ?? undefined;
    mergedAt = after.mergedAt;
  } catch {
    notes.push('The merge went through, but GitHub could not be asked for the new commit afterwards.');
  }

  try {
    await setPullRequestState(pullRequestKey(repoPath, number), 'MERGED', {
      ...(mergedAt ? { mergedAt } : {}),
      ...(mergeCommit ? { mergeCommit } : {}),
    });
  } catch {
    // The next `pr-check` finds out from GitHub anyway.
  }

  // The roadmap moves on, and the task's checkout goes - BEFORE the local branch is deleted below: git
  // will not delete a branch that is checked out, and the checkout is where this branch is checked out.
  const settled = await settlePullRequest({
    repoPath,
    number,
    state: 'MERGED',
    mergeCommit,
    mergedAt,
  });
  notes.push(...settled.notes);
  const checkoutKept = settled.checkout !== null && !settled.checkout.removed;

  let remoteDeleted = false;
  if (options.deleteBranch) {
    const defaultBranch = await getDefaultBranch(repoPath);
    if (facts.isCrossRepository) {
      notes.push(`Kept the branch ${facts.headBranch}: it belongs to a fork.`);
    } else if (facts.headBranch === facts.baseBranch || facts.headBranch === defaultBranch) {
      notes.push(`Kept the branch ${facts.headBranch}: it is the repository's main branch.`);
    } else {
      const dependants = await pullRequestsBasedOn(repoPath, facts.headBranch);
      if (dependants === null) {
        notes.push(`Kept the branch ${facts.headBranch}: GitHub could not say whether other pull requests are based on it.`);
      } else if (dependants.length > 0) {
        notes.push(
          `Kept the branch ${facts.headBranch}: ${dependants.map((n) => `#${n}`).join(', ')} ` +
            `${dependants.length === 1 ? 'is' : 'are'} based on it.`,
        );
      } else {
        const removed = await deleteRemoteBranch(repoPath, facts.headBranch);
        remoteDeleted = removed.ok;
        notes.push(
          removed.ok
            ? `Deleted the branch ${facts.headBranch} on GitHub.`
            : `Could not delete the branch ${facts.headBranch} on GitHub: ${removed.reason}`,
        );
      }
    }
  }

  try {
    notes.push(
      ...(await tidyWorkingCopy({
        repoPath,
        headBranch: facts.headBranch,
        baseBranch: facts.baseBranch,
        mergedHeadSha: facts.headSha,
        allowSwitch: options.returnToBase,
        deleteLocalBranch: remoteDeleted && !checkoutKept,
        explainUntouched: settled.checkout !== null,
      })),
    );
    if (checkoutKept && remoteDeleted) {
      notes.push(`Kept the local branch ${facts.headBranch}: it is still checked out at ${settled.checkout!.path}.`);
    }
  } catch (error) {
    notes.push(`Your working copy could not be tidied: ${firstLine((error as Error).message)}`);
  }

  return {
    merged: true,
    ...(mergeCommit ? { mergeCommit } : {}),
    baseBranch: facts.baseBranch,
    headBranch: facts.headBranch,
    notes,
    ...(settled.phase ? { phase: settled.phase } : {}),
  };
}
