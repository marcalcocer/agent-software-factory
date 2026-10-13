/**
 * IPC handlers for settings management.
 */
import { ipcMain } from 'electron';
import type { Settings } from '../../shared/types';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

// Settings stored in user data directory
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

export function loadSettings(): Settings {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }

  // Default settings
  return {
    global: {
      theme: 'system',
      workspaceRoot: path.join(app.getPath('home'), 'workspace'),
      defaultMaxAttempts: 3,
      dryRunByDefault: false,
      allowPush: false,
      allowPR: false,
      logLevel: 'info',
      activeProvider: 'claude-cli',
    },
    repos: {},
  };
}

export function saveSettings(settings: Settings): void {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

ipcMain.handle('settings:get', async (): Promise<Settings> => {
  return loadSettings();
});

ipcMain.handle('settings:update', async (_event, updates: Partial<Settings>): Promise<void> => {
  const current = loadSettings();
  const updated = { ...current, ...updates };
  saveSettings(updated);
});

ipcMain.handle('settings:getRepo', async (_event, repoId: string): Promise<Settings['repos'][string] | null> => {
  const settings = loadSettings();
  return settings.repos[repoId] || null;
});

ipcMain.handle('settings:updateRepo', async (
  _event,
  repoId: string,
  updates: Partial<Settings['repos'][string]>
): Promise<void> => {
  const settings = loadSettings();
  settings.repos[repoId] = { ...settings.repos[repoId], ...updates, repoId };
  saveSettings(settings);
});
