import { useEffect, useState } from 'react';
import type { Places, PrWatchSettingsBundle } from '../../shared/types';
import type { ThemeSetting } from '../theme';
import { PullRequestSettings } from './PullRequestSettings';
import { WorktreeList } from './WorktreeList';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onThemeChange?: (theme: ThemeSetting) => void;
  /** Called after the settings were saved, with the ones the rest of the screen depends on. */
  onSaved?: (settings: { isolation: 'worktree' | 'in-place' }) => void;
}

interface Settings {
  theme: 'dark' | 'light' | 'system';
  workspaceRoot: string;
  /** Where each task's checkout is made. Absent: the factory's default, inside the workspace. */
  worktreesDir?: string;
  defaultMaxAttempts: number;
  dryRunByDefault: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  activeProvider: 'claude-cli' | 'api';
  /** Where a task works unless its form says otherwise. Absent: an isolated worktree. */
  isolation?: 'worktree' | 'in-place';
  /** Compare the roadmap with what a phase delivered when it is merged. Absent: yes. */
  autoReconcile?: boolean;
  autoRetryOnUsageLimit?: boolean;
}

/**
 * What the factory is using for a place, said by the factory - and why the field above may not be the reason: the
 * environment the Studio was started with decides some places, and a checkouts folder can be somewhere a restart clears.
 */
function InUse({ folder, variable, places, volatile = false }: { folder: string | undefined; variable: string; places: Places | null; volatile?: boolean }) {
  if (!places || !folder) return null;
  return (
    <div className="mt-1 space-y-1 text-xs" data-testid={`in-use-${variable}`}>
      <p className="text-slate-500 dark:text-slate-400">
        In use now: <code className="font-mono break-all">{folder}</code>
      </p>
      {places.fixedBy.includes(variable) && (
        <p className="text-amber-700 dark:text-amber-300">{variable} is set where the Studio was started, so this field is not used.</p>
      )}
      {volatile && (
        <p role="note" className="text-amber-700 dark:text-amber-300">
          This folder is in the system&apos;s temporary folder: a restart can clear it, and with it any work in a checkout that is not committed. Choose a
          folder that stays.
        </p>
      )}
    </div>
  );
}

export function SettingsPanel({ isOpen, onClose, onThemeChange, onSaved }: SettingsPanelProps) {
  const [settings, setSettings] = useState<Settings>({
    theme: 'system',
    workspaceRoot: '',
    defaultMaxAttempts: 3,
    dryRunByDefault: false,
    logLevel: 'info',
    activeProvider: 'claude-cli',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /** Pull-request settings are owned by the watcher; `null` until they have been read. */
  const [prSettings, setPrSettings] = useState<PrWatchSettingsBundle | null>(null);
  const [repoNames, setRepoNames] = useState<Array<{ name: string; path: string }>>([]);
  /** Where the factory works, as it says; `null` until it has answered (it is a process of its own). */
  const [places, setPlaces] = useState<Places | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadSettings();
    }
  }, [isOpen]);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const savedSettings = await window.api.invoke('settings:get');
      if (savedSettings?.global) {
        setSettings(savedSettings.global);
      }
      // Independent of the general settings: if either is unavailable the rest still works.
      const [bundle, repos, where] = await Promise.all([
        window.api.invoke('pr-watch:get-settings').catch(() => null),
        window.api.invoke('factory:list-repos').catch(() => []),
        window.api.invoke('places:get').catch(() => null),
      ]);
      setPrSettings(bundle);
      setRepoNames(repos.map((repo) => ({ name: repo.name, path: repo.path })));
      setPlaces(where);
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // A field left empty is not a setting: the key goes, and the factory's default applies.
      const { worktreesDir, ...rest } = settings;
      const chosen = worktreesDir?.trim();
      await window.api.invoke('settings:update', { global: { ...rest, ...(chosen ? { worktreesDir: chosen } : {}) } });
      if (prSettings) {
        await window.api.invoke('pr-watch:save-settings', { defaults: prSettings.defaults, repos: prSettings.repos });
      }
      onSaved?.({ isolation: settings.isolation ?? 'worktree' });
      onClose();
    } catch (error) {
      console.error('Failed to save settings:', error);
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 overflow-y-auto">
          {loading ? (
            <div className="text-center text-slate-500 py-8">Loading settings...</div>
          ) : (
            <>
              {/* Theme */}
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                  Theme
                </label>
                <select
                  value={settings.theme}
                  onChange={(e) => {
                    const theme = e.target.value as Settings['theme'];
                    setSettings({ ...settings, theme });
                    onThemeChange?.(theme);
                  }}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900"
                >
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </div>

              {/* Workspace */}
              <div>
                <label htmlFor="workspace-root" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                  Workspace
                </label>
                <input
                  id="workspace-root"
                  type="text"
                  value={settings.workspaceRoot}
                  onChange={(e) => setSettings({ ...settings, workspaceRoot: e.target.value })}
                  placeholder="/path/to/workspace"
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900"
                />
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Where a repository is found by its name. A repository anywhere else works too: add it with + in the sidebar.
                </p>
                <InUse folder={places?.workspaceRoot} variable="FACTORY_WORKSPACE_ROOT" places={places} />
              </div>

              {/* Default Max Attempts */}
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                  Max Iterations (Safety Limit)
                </label>
                <input
                  type="number"
                  value={settings.defaultMaxAttempts}
                  onChange={(e) => setSettings({ ...settings, defaultMaxAttempts: parseInt(e.target.value) || 3 })}
                  min={1}
                  max={10}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900"
                />
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Maximum dev/QA/review cycles before escalation (prevents runaway costs)
                </p>
              </div>

              {/* Toggles */}
              <div className="space-y-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.dryRunByDefault}
                    onChange={(e) => setSettings({ ...settings, dryRunByDefault: e.target.checked })}
                    className="rounded border-slate-300 dark:border-slate-600"
                  />
                  <div className="flex-1">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300 block">
                      Dry Run Mode
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      Test without API calls or git writes (no cost)
                    </span>
                  </div>
                </label>

                <div className="text-xs text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-700/50 rounded p-2">
                  Push and pull-request creation are decided per run: the pipeline pauses at the
                  delivery step and asks you.
                </div>
              </div>

              {/* Where tasks work, and the roadmap */}
              <div className="space-y-3 pt-4 border-t border-slate-200 dark:border-slate-700">
                <div>
                  <label htmlFor="isolation-default" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                    Where tasks work
                  </label>
                  <select
                    id="isolation-default"
                    value={settings.isolation ?? 'worktree'}
                    onChange={(e) => setSettings({ ...settings, isolation: e.target.value as 'worktree' | 'in-place' })}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900"
                  >
                    <option value="worktree">An isolated worktree (recommended)</option>
                    <option value="in-place">My repository</option>
                  </select>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    A worktree is a copy of the repository for the task alone: your folder is not touched and may have changes, and
                    several tasks can run at once. Each task can still choose on its form.
                  </p>
                </div>

                <div>
                  <label htmlFor="worktrees-dir" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                    Where worktrees are kept
                  </label>
                  <input
                    id="worktrees-dir"
                    type="text"
                    value={settings.worktreesDir ?? ''}
                    onChange={(e) => setSettings({ ...settings, worktreesDir: e.target.value })}
                    placeholder="Empty: a hidden folder inside the workspace"
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900"
                  />
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    One folder for every repository. Keep it somewhere that survives a restart, and not inside a project that has node_modules: a
                    checkout there would find that project&apos;s packages, and its tests could pass here and fail in CI. A change applies to the
                    tasks started after it; checkouts already made stay where they are.
                  </p>
                  <InUse folder={places?.worktreesDir} variable="FACTORY_WORKTREES_DIR" places={places} volatile={places?.volatile ?? false} />
                </div>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.autoReconcile !== false}
                    onChange={(e) => setSettings({ ...settings, autoReconcile: e.target.checked })}
                    className="rounded border-slate-300 dark:border-slate-600"
                  />
                  <div className="flex-1">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300 block">Compare the roadmap with what a phase delivered</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      When a phase is merged, one cheap model call checks the phases still to come against what really changed.
                    </span>
                  </div>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="auto-retry-setting"
                    checked={settings.autoRetryOnUsageLimit !== false}
                    onChange={(e) => setSettings({ ...settings, autoRetryOnUsageLimit: e.target.checked })}
                    className="rounded border-slate-300 dark:border-slate-600"
                  />
                  <div className="flex-1">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300 block">Retry automatically when Claude&apos;s usage limit resets</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      A run that stops because the limit was reached continues by itself a minute after it resets, from the step that
                      stopped. Each run can still be cancelled or retried earlier. The Studio has to be open; if it was closed, the run is
                      retried when you open it.
                    </span>
                  </div>
                </label>

                <WorktreeList repos={repoNames} />
              </div>

              {/* Log Level */}
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                  Log Level
                </label>
                <select
                  value={settings.logLevel}
                  onChange={(e) => setSettings({ ...settings, logLevel: e.target.value as Settings['logLevel'] })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900"
                >
                  <option value="debug">Debug</option>
                  <option value="info">Info</option>
                  <option value="warn">Warning</option>
                  <option value="error">Error</option>
                </select>
              </div>

              {prSettings && (
                <div className="pt-4 border-t border-slate-200 dark:border-slate-700">
                  <PullRequestSettings value={prSettings} repos={repoNames} onChange={setPrSettings} />
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-md transition-colors"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
