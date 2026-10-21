/**
 * Where a task works - the answer to "where is the code I am being asked to review?".
 *
 * A task works either in a checkout of its own (an isolated worktree: a second copy of the repository,
 * on the task's branch, that the user's own folder never feels) or in the user's repository itself. This
 * says which, shows the folder and the branch, and offers what the user needs to look at it by hand:
 * copy the path, open the folder, and - for a checkout - remove it or move its branch into their
 * repository to run it where they work.
 *
 * Every action names a RUN, never a path: the main process finds the folder from the run's own record.
 */
import { useCallback, useEffect, useState } from 'react';

import type { WorkCopy, WorktreeInfo } from '@shared/types';
import { ConfirmModal } from './ConfirmModal';

/** Electron wraps an error thrown in the main process; the user should read only what it said. */
const messageOf = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Copies text; false when the platform would not (the caller says so instead of pretending). */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const button =
  'px-2.5 py-1 rounded-md text-xs font-medium border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed';

function ModeBadge({ isolation }: { isolation: 'worktree' | 'in-place' }) {
  return isolation === 'worktree' ? (
    <span
      data-testid="work-mode"
      title="This task has a copy of the repository to itself. Your own folder is not touched."
      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
    >
      Isolated worktree
    </span>
  ) : (
    <span
      data-testid="work-mode"
      title="This task works in your repository itself, on its own branch."
      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200"
    >
      Your repository
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* On a run                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a run shows until it has said where it works. The factory decides that (and makes the checkout) while
 * it prepares the run, a little after the run record exists - and a record without a working copy reads as
 * "your repository", which for a task about to get a checkout of its own is the opposite of the truth.
 */
export function WorkingCopyPreparing() {
  return (
    <section
      aria-label="Where this task works"
      data-testid="working-copy-preparing"
      className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-xs text-slate-500 dark:text-slate-400"
    >
      Preparing the working copy...
    </section>
  );
}

interface WorkingCopyBarProps {
  runId: string;
  /** Changes when the run's state does (it finished, a round started): the folder is looked at again. */
  refreshKey?: string;
  /** Called after the checkout was removed or moved, so the screen can refresh what depends on it. */
  onChanged?: () => void;
}

type Confirming = null | 'remove' | 'remove-anyway' | 'checkout';

export function WorkingCopyBar({ runId, refreshKey, onChanged }: WorkingCopyBarProps) {
  const [info, setInfo] = useState<WorktreeInfo | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'problem'; text: string } | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await window.api.invoke('worktree:info', runId));
    } catch {
      setInfo(null);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!info) return null;

  const isCheckout = info.isolation === 'worktree';
  const act = async (work: () => Promise<{ tone: 'ok' | 'problem'; text: string } | null>) => {
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await work();
      if (outcome) setNotice(outcome);
    } catch (err) {
      setNotice({ tone: 'problem', text: messageOf(err) });
    } finally {
      setBusy(false);
      await load();
    }
  };

  const copy = () =>
    act(async () =>
      (await copyToClipboard(info.path))
        ? { tone: 'ok', text: 'Path copied.' }
        : { tone: 'problem', text: `Could not copy it. The path is ${info.path}` },
    );
  const open = () =>
    act(async () => {
      await window.api.invoke('worktree:open', runId);
      return null;
    });

  const remove = (force: boolean) =>
    act(async () => {
      const result = await window.api.invoke('worktree:remove', runId, { force });
      if (!result.removed) {
        // Refused because of changes that are not committed: the reason is the answer, and "anyway" is the user's call.
        if (result.message?.includes('not committed')) setConfirming('remove-anyway');
        return { tone: 'problem', text: result.message ?? 'The folder was not removed.' };
      }
      onChanged?.();
      return { tone: 'ok', text: info.branch ? `Removed. The branch ${info.branch} still has the work.` : 'Removed.' };
    });

  const checkoutHere = () =>
    act(async () => {
      const result = await window.api.invoke('worktree:checkout', runId);
      if (!result.ok) return { tone: 'problem', text: result.error ?? 'The branch could not be checked out.' };
      onChanged?.();
      return { tone: 'ok', text: `Your repository is now on ${result.branch}. The task's own folder was removed.` };
    });

  const gone = isCheckout && !info.exists;

  return (
    <section aria-label="Where this task works" data-testid="working-copy" className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ModeBadge isolation={info.isolation} />
        {info.branch && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            branch <span className="font-mono text-slate-700 dark:text-slate-200" data-testid="work-branch">{info.branch}</span>
          </span>
        )}
        {isCheckout && info.exists && info.changedFiles > 0 && (
          <span data-testid="work-changes" className="text-xs text-amber-700 dark:text-amber-300">
            {info.changedFiles} file{info.changedFiles === 1 ? '' : 's'} with changes not committed
          </span>
        )}
        {gone && <span className="text-xs text-slate-500 dark:text-slate-400">The checkout is gone (its pull request is over, or it was removed).</span>}
      </div>

      <p className="font-mono text-xs break-all text-slate-700 dark:text-slate-200" data-testid="work-path" title={info.path}>
        {info.path}
      </p>

      {gone && info.branch && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          The work is on the branch: <span className="font-mono">git checkout {info.branch}</span> in your repository.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={copy} className={button}>
          Copy path
        </button>
        {!gone && (
          <button type="button" disabled={busy} onClick={open} className={button}>
            Open folder
          </button>
        )}
        {isCheckout && info.exists && (
          <>
            <button type="button" disabled={busy} onClick={() => setConfirming('checkout')} className={button} title="Move this branch into your own repository, to run it where you work">
              Check out here
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming('remove')} className={button}>
              Remove worktree
            </button>
          </>
        )}
      </div>

      {notice && (
        <p
          role={notice.tone === 'problem' ? 'alert' : 'status'}
          data-testid="work-notice"
          className={`text-xs ${notice.tone === 'problem' ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'}`}
        >
          {notice.text}
        </p>
      )}

      <ConfirmModal
        isOpen={confirming === 'remove'}
        title="Remove the worktree"
        message={`Remove the folder ${info.path}? The branch ${info.branch ?? ''} and everything committed on it stay; the folder can be made again from it.`}
        confirmText="Remove"
        variant="warning"
        onConfirm={() => {
          setConfirming(null);
          void remove(false);
        }}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmModal
        isOpen={confirming === 'remove-anyway'}
        title="Remove it anyway?"
        message={`The folder has changes that are not committed. Removing it throws them away. The branch ${info.branch ?? ''} and what is committed on it stay.`}
        confirmText="Remove and lose the changes"
        variant="danger"
        onConfirm={() => {
          setConfirming(null);
          void remove(true);
        }}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmModal
        isOpen={confirming === 'checkout'}
        title="Check out the branch in your repository"
        message={`This removes the task's own folder and checks ${info.branch ?? 'its branch'} out in your repository, so you can run it there. Your repository must have no uncommitted changes.`}
        confirmText="Check it out"
        variant="info"
        onConfirm={() => {
          setConfirming(null);
          void checkoutHere();
        }}
        onCancel={() => setConfirming(null)}
      />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* On a pull request                                                           */
/* -------------------------------------------------------------------------- */

/** One line for a pull request's card: where its code is, with the two things you do with a path. */
export function WorkingCopyLine({ workCopy, rootRunId }: { workCopy: WorkCopy; rootRunId: string }) {
  const [said, setSaid] = useState<string | null>(null);
  const gone = workCopy.isolation === 'worktree' && !workCopy.exists;

  const say = (text: string) => {
    setSaid(text);
    setTimeout(() => setSaid(null), 4000);
  };

  return (
    <div data-testid="pr-work-copy" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
      <ModeBadge isolation={workCopy.isolation} />
      <span className="font-mono break-all text-slate-700 dark:text-slate-200" title={workCopy.path}>
        {workCopy.path}
      </span>
      {gone && <span>(removed - made again when a round needs it)</span>}
      <button
        type="button"
        className="underline"
        onClick={async () => say((await copyToClipboard(workCopy.path)) ? 'Path copied.' : 'Could not copy it.')}
      >
        Copy path
      </button>
      {!gone && (
        <button
          type="button"
          className="underline"
          onClick={() =>
            window.api
              .invoke('worktree:open', rootRunId)
              .catch((err: unknown) => say(messageOf(err)))
          }
        >
          Open folder
        </button>
      )}
      {said && (
        <span role="status" className="text-emerald-700 dark:text-emerald-300">
          {said}
        </span>
      )}
    </div>
  );
}
