/**
 * The checkouts the factory made for tasks, per repository: where each is, which task it belongs to, whether
 * it has work in it that is not committed, and whether its pull request is over (so it is not needed any
 * more). "Clean up" removes the finished ones that have nothing in them; anything with uncommitted changes
 * stays, and is listed with the reason.
 *
 * Read on demand: listing means asking git about every checkout, which is not worth doing every time Settings opens.
 */
import { useState } from 'react';

import type { WorktreeReport } from '@shared/types';
import { errorText } from '../lib/errorText';


const small =
  'px-2.5 py-1 rounded-md text-xs font-medium border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed';

interface Group {
  repo: { name: string; path: string };
  checkouts: WorktreeReport[];
  kept: Array<{ path: string; message: string }>;
}

export function WorktreeList({ repos }: { repos: Array<{ name: string; path: string }> }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setBusy('load');
    setError(null);
    try {
      const loaded = await Promise.all(
        repos.map(async (repo): Promise<Group> => ({ repo, checkouts: await window.api.invoke('worktree:list', repo.path), kept: [] })),
      );
      setGroups(loaded);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const cleanUp = async (repo: { name: string; path: string }) => {
    setBusy(`gc:${repo.path}`);
    setError(null);
    try {
      const result = await window.api.invoke('worktree:gc', repo.path);
      const checkouts = await window.api.invoke('worktree:list', repo.path);
      setGroups((previous) => (previous ?? []).map((group) => (group.repo.path === repo.path ? { ...group, checkouts, kept: result.kept } : group)));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (repo: { name: string; path: string }, checkout: WorktreeReport) => {
    if (!checkout.rootRunId) return;
    setBusy(`rm:${checkout.path}`);
    setError(null);
    try {
      const result = await window.api.invoke('worktree:remove', checkout.rootRunId);
      if (!result.removed) setError(result.message ?? 'It was not removed.');
      const checkouts = await window.api.invoke('worktree:list', repo.path);
      setGroups((previous) => (previous ?? []).map((group) => (group.repo.path === repo.path ? { ...group, checkouts } : group)));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="worktree-list" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Checkouts</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">The folders tasks work in. The branch always stays when a folder is removed.</p>
        </div>
        <button type="button" disabled={busy !== null || repos.length === 0} onClick={load} className={small}>
          {busy === 'load' ? 'Reading...' : groups ? 'Refresh' : 'Show them'}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {groups?.map(({ repo, checkouts, kept }) => (
        <div key={repo.path} data-testid={`worktrees-${repo.name}`} className="rounded border border-slate-200 dark:border-slate-700 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{repo.name}</span>
            {checkouts.some((checkout) => checkout.stale) && (
              <button type="button" disabled={busy !== null} onClick={() => cleanUp(repo)} className={small}>
                {busy === `gc:${repo.path}` ? 'Cleaning...' : 'Clean up finished'}
              </button>
            )}
          </div>

          {checkouts.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">No checkouts.</p>
          ) : (
            <ul className="space-y-2">
              {checkouts.map((checkout) => (
                <li key={checkout.path} className="space-y-0.5 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-800 dark:text-slate-200">{checkout.title ?? checkout.taskId}</span>
                    {checkout.pullRequest && (
                      <span className="text-slate-500 dark:text-slate-400">
                        #{checkout.pullRequest.number} {checkout.pullRequest.state.toLowerCase()}
                      </span>
                    )}
                    {checkout.stale && <span className="px-1.5 rounded bg-slate-100 dark:bg-slate-700">finished</span>}
                    {checkout.changedFiles > 0 && (
                      <span className="text-amber-700 dark:text-amber-300">
                        {checkout.changedFiles} file{checkout.changedFiles === 1 ? '' : 's'} not committed
                      </span>
                    )}
                    {!checkout.registered && <span className="text-red-700 dark:text-red-300">not a checkout git knows - left alone</span>}
                    <span className="flex-1" />
                    {checkout.registered && checkout.rootRunId && (
                      <button type="button" disabled={busy !== null} onClick={() => remove(repo, checkout)} className={small}>
                        Remove
                      </button>
                    )}
                  </div>
                  <p className="font-mono break-all text-slate-500 dark:text-slate-400">{checkout.path}</p>
                  {checkout.branch && <p className="font-mono text-slate-500 dark:text-slate-400">{checkout.branch}</p>}
                </li>
              ))}
            </ul>
          )}

          {kept.length > 0 && (
            <ul className="list-disc list-inside text-xs text-amber-700 dark:text-amber-300">
              {kept.map((entry) => (
                <li key={entry.path}>{entry.message}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
