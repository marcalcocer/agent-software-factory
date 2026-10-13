import { useEffect, useState } from 'react';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Settings {
  theme: 'dark' | 'light' | 'system';
  workspaceRoot: string;
  defaultMaxAttempts: number;
  dryRunByDefault: boolean;
  allowPush: boolean;
  allowPR: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  activeProvider: 'claude-cli' | 'api';
}

export function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState<Settings>({
    theme: 'system',
    workspaceRoot: '',
    defaultMaxAttempts: 3,
    dryRunByDefault: false,
    allowPush: false,
    allowPR: false,
    logLevel: 'info',
    activeProvider: 'claude-cli',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await window.api.invoke('settings:update', { global: settings });
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
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-lg">
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
        <div className="p-6 space-y-6">
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
                  onChange={(e) => setSettings({ ...settings, theme: e.target.value as Settings['theme'] })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900"
                >
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </div>

              {/* Workspace Root */}
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                  Workspace Root
                </label>
                <input
                  type="text"
                  value={settings.workspaceRoot}
                  onChange={(e) => setSettings({ ...settings, workspaceRoot: e.target.value })}
                  placeholder="/path/to/workspace"
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900"
                />
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

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.allowPush}
                    onChange={(e) => setSettings({ ...settings, allowPush: e.target.checked })}
                    className="rounded border-slate-300 dark:border-slate-600"
                  />
                  <span className="text-sm text-slate-700 dark:text-slate-300">
                    Allow Git Push
                  </span>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.allowPR}
                    onChange={(e) => setSettings({ ...settings, allowPR: e.target.checked })}
                    className="rounded border-slate-300 dark:border-slate-600"
                  />
                  <span className="text-sm text-slate-700 dark:text-slate-300">
                    Allow Pull Request Creation
                  </span>
                </label>
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
