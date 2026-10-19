/**
 * How the follow-up run for pull-request feedback is configured.
 *
 * Review comments are addressed by adding commits to the pull request's own branch, so the new
 * commit updates that pull request. Starting from the repository's current HEAD instead - which
 * is what happened before - produced a brand-new branch stacked on top of the PR branch, i.e. a
 * second pull request that depended on the first.
 */
export type FollowUpFlags = Record<string, string | boolean>;

export interface FollowUpSource {
  followUpTask: string;
  /** Branch the pull request is opened from. */
  headBranch: string;
  /** Branch the pull request targets. */
  baseBranch: string;
}

/**
 * Flags for a normal `run` that continues on the PR branch.
 *
 * `branch` and `base-branch` always come from the pull request: they override anything the
 * caller passed, because the follow-up only makes sense on that branch.
 */
export function followUpRunFlags(flags: FollowUpFlags, source: FollowUpSource): FollowUpFlags {
  return {
    ...flags,
    task: source.followUpTask,
    branch: source.headBranch,
    'base-branch': source.baseBranch,
  };
}
