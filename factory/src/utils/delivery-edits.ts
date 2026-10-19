/**
 * The human's edits at the delivery approval gate: cleaning them up, remembering them, and
 * resolving a branch that was renamed.
 *
 * The workflow state Mastra persists is the state *before* the human answered, so anything the
 * human changed has to be recorded somewhere a retry can find it. That place is the event log:
 * `human_input` carries the edits and `branch_renamed` the rename.
 */
import { readEvents } from '../tools/logger-tools.ts';
import type { DeliveryEdits } from './schemas.ts';

/** Normalises line endings (textareas on some platforms submit CRLF). */
const normaliseNewlines = (value: string): string => value.replace(/\r\n?/g, '\n');

/**
 * Cleans edits coming from a UI or the command line.
 *
 * - Title and commit message must not be blank - a blank one means "keep the proposal".
 * - A title is a single line.
 * - The description may legitimately be emptied, so it is only normalised.
 */
export function sanitizeDeliveryEdits(raw: DeliveryEdits | undefined | null): DeliveryEdits {
  if (!raw) return {};
  const edits: DeliveryEdits = {};

  const title = raw.pullRequestTitle?.replace(/\s*\n\s*/g, ' ').trim();
  if (title) edits.pullRequestTitle = title;

  const commit = raw.commitMessage === undefined ? undefined : normaliseNewlines(raw.commitMessage).trim();
  if (commit) edits.commitMessage = commit;

  if (raw.pullRequestBody !== undefined) edits.pullRequestBody = normaliseNewlines(raw.pullRequestBody);

  const branch = raw.branchName?.trim();
  if (branch) edits.branchName = branch;

  return edits;
}

/**
 * Parses the `--edits '<json>'` command-line value. Unknown keys and wrong types are dropped
 * rather than failing: a malformed edit must never block the delivery itself.
 */
export function parseDeliveryEditsJson(json: string | undefined): DeliveryEdits {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const pick = (key: keyof DeliveryEdits): string | undefined =>
      typeof parsed[key] === 'string' ? (parsed[key] as string) : undefined;
    return sanitizeDeliveryEdits({
      commitMessage: pick('commitMessage'),
      pullRequestTitle: pick('pullRequestTitle'),
      pullRequestBody: pick('pullRequestBody'),
      branchName: pick('branchName'),
    });
  } catch {
    return {};
  }
}

/**
 * The edits the human last submitted at the delivery gate, or `{}`.
 *
 * Approvals without edits do not erase earlier ones: an approval that changed nothing was
 * made against a form that was pre-filled from the earlier edits, so those still stand.
 */
export function latestDeliveryEdits(runId: string): DeliveryEdits {
  const events = readEvents(runId);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as Record<string, unknown>;
    if (event.type !== 'human_input' || event.gate !== 'DELIVERY_APPROVAL_REQUIRED') continue;
    if (event.edits && typeof event.edits === 'object') {
      return sanitizeDeliveryEdits(event.edits as DeliveryEdits);
    }
  }
  return {};
}

/** One thing the delivery step did, as recorded in the event log. */
export interface DeliveryAction {
  at: string;
  action: string;
  ok: boolean;
  detail: string;
}

/**
 * What the delivery step already did in earlier executions of the same run, oldest first.
 *
 * The step runs more than once: it commits, then pauses for the human's approval, and only the
 * execution after the answer writes the report. (A retry after a failed push is another one.) The
 * report has to describe the whole delivery, not just the last execution - otherwise it says
 * "nothing to commit" about a delivery that committed a moment before the approval gate.
 * Read it before this execution records anything of its own.
 */
export function earlierDeliveryActions(runId: string): DeliveryAction[] {
  const actions: DeliveryAction[] = [];
  for (const event of readEvents(runId) as Array<Record<string, unknown>>) {
    if (event.type !== 'delivery_action') continue;
    if (typeof event.action !== 'string' || typeof event.at !== 'string') continue;
    actions.push({
      at: event.at,
      action: event.action,
      ok: event.ok === true,
      detail: typeof event.detail === 'string' ? event.detail : '',
    });
  }
  return actions;
}

/**
 * The branch the run's work lives on *now*. The persisted run context still holds the name the
 * run was created with, so a rename made at an earlier delivery attempt is followed through the
 * `branch_renamed` events.
 */
export function currentWorkBranch(runId: string, original: string): string {
  let branch = original;
  for (const event of readEvents(runId) as Array<Record<string, unknown>>) {
    if (event.type === 'branch_renamed' && event.from === branch && typeof event.to === 'string') {
      branch = event.to;
    }
  }
  return branch;
}
