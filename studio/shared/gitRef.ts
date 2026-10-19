/**
 * Early feedback for a branch name typed into the delivery form.
 *
 * This mirrors the rules of `git check-ref-format` closely enough to catch the usual mistakes
 * (spaces, `..`, a trailing slash) while the user is still typing. It is advisory only: the
 * factory validates the name with git itself before renaming anything, and refuses a bad one
 * with a note instead of failing the delivery.
 *
 * Pure (no Node, no DOM).
 */

/** A human-readable reason the name is not acceptable, or `null` when it looks fine. */
export function branchNameProblem(name: string): string | null {
  if (name.trim() === '') return 'The branch name cannot be empty.';
  if (name !== name.trim()) return 'The branch name cannot start or end with a space.';
  if (/\s/.test(name)) return 'The branch name cannot contain spaces.';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f~^:?*[\\]/.test(name)) {
    return 'The branch name cannot contain  ~ ^ : ? * [ \\  or control characters.';
  }
  if (name.includes('..')) return 'The branch name cannot contain "..".';
  if (name.includes('@{')) return 'The branch name cannot contain "@{".';
  if (name === '@') return 'The branch name cannot be "@".';
  if (name.startsWith('-')) return 'The branch name cannot start with "-".';
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    return 'The branch name cannot start or end with "/" or contain "//".';
  }
  if (name.endsWith('.')) return 'The branch name cannot end with ".".';
  if (name.endsWith('.lock') || name.split('/').some((part) => part.endsWith('.lock'))) {
    return 'No part of the branch name can end with ".lock".';
  }
  if (name.split('/').some((part) => part.startsWith('.'))) {
    return 'No part of the branch name can start with ".".';
  }
  return null;
}
