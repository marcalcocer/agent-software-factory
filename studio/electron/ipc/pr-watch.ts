/**
 * Connects the pull-request watcher (`services/pr-watcher.ts`) to the real world: the factory CLI,
 * the run directories, the settings file and the renderer.
 *
 * All the decisions live in the watcher; this file only supplies its dependencies.
 */
import { app, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  PrMergeDraft,
  PrMergeResult,
  PrWatchSettings,
  PrWatchSettingsBundle,
  PrWatchState,
  RepoPrWatchOverrides,
} from '../../shared/types';
import { mainWindow } from '../main.js';
import { ensureClaudeAuth } from '../services/claude-auth.js';
import { findLatestPrFeedback } from '../services/pr-feedback.js';
import { PrWatcher, type WatcherMemory } from '../services/pr-watcher.js';
import {
  LOGS_DIR,
  findBusyRun,
  isRunActive,
  listRoundsOf,
  runEvents,
  runFactoryCli,
  startFactoryRun,
} from './factory.js';
import { loadSettings, saveSettings } from './settings.js';

const memoryFile = (): string => path.join(app.getPath('userData'), 'pr-watch-memory.json');

function loadMemory(): WatcherMemory {
  try {
    const raw = JSON.parse(fs.readFileSync(memoryFile(), 'utf8')) as Partial<WatcherMemory>;
    return {
      triageAttempts: raw.triageAttempts ?? {},
      reviseAttempts: raw.reviseAttempts ?? {},
      approvals: raw.approvals ?? {},
    };
  } catch {
    return { triageAttempts: {}, reviseAttempts: {}, approvals: {} };
  }
}

function saveMemory(memory: WatcherMemory): void {
  try {
    // Written next to its final name and renamed: a crash mid-write never leaves a torn file.
    const temp = `${memoryFile()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(memory, null, 2), 'utf8');
    fs.renameSync(temp, memoryFile());
  } catch (error) {
    console.error('[PR watch] could not save its memory:', error);
  }
}

/** `git status --porcelain` is empty. Unknown (git failed) counts as NOT clean: do not start on a guess. */
function isClean(repoPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['status', '--porcelain'], { cwd: repoPath });
    let out = '';
    proc.stdout?.on('data', (data) => (out += data.toString()));
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0 && out.trim() === ''));
  });
}

const watcher = new PrWatcher({
  runCli: runFactoryCli,

  async startRun(args, { userInitiated }) {
    // A click may ask the user to sign in; a round started in the background must never pop that
    // up (and `ensureClaudeAuth` makes a real model call - not something to do every minute).
    if (userInitiated && !(await ensureClaudeAuth())) {
      throw new Error('Authentication required. Please log in to Claude CLI.');
    }
    return await startFactoryRun(args);
  },

  findBusyRun,
  isRunActive,
  listRounds: listRoundsOf,
  latestTriage: (repoPath, number) => findLatestPrFeedback(LOGS_DIR, repoPath, number),
  isClean,
  isDryRun: () => loadSettings().global.dryRunByDefault === true,

  loadSettings: () => loadSettings().prWatch,
  saveSettings: (prWatch: PrWatchSettings) => saveSettings({ ...loadSettings(), prWatch }),

  // Overrides live in each repository's own settings entry, next to its other per-repo settings.
  loadRepoOverrides: () =>
    Object.fromEntries(Object.entries(loadSettings().repos ?? {}).map(([name, repo]) => [name, repo.prWatch ?? {}])),
  saveRepoOverrides: (overrides: Record<string, RepoPrWatchOverrides>) => {
    const settings = loadSettings();
    const repos = { ...settings.repos };
    for (const name of new Set([...Object.keys(repos), ...Object.keys(overrides)])) {
      const existing = repos[name];
      const next = overrides[name];
      if (next && Object.keys(next).length > 0) {
        repos[name] = { ...(existing ?? {}), repoId: name, prWatch: next };
      } else if (existing) {
        // Back to the defaults: drop only the overrides, keep the repository's other settings.
        const { prWatch: _removed, ...rest } = existing;
        repos[name] = rest;
      }
    }
    saveSettings({ ...settings, repos });
  },
  loadMemory,
  saveMemory,

  emit: (state: PrWatchState) => mainWindow?.webContents.send('pr-watch:changed', state),

  now: () => Date.now(),
  log: (message) => console.log('[PR watch]', message),
});

ipcMain.handle('pr-watch:get', async (): Promise<PrWatchState> => watcher.getState());
ipcMain.handle('pr-watch:refresh', async (): Promise<void> => watcher.refresh());
ipcMain.handle('pr-watch:get-settings', async (): Promise<PrWatchSettingsBundle> => watcher.getSettings());
ipcMain.handle(
  'pr-watch:save-settings',
  async (
    _event,
    bundle: { defaults?: Partial<PrWatchSettings>; repos?: Record<string, RepoPrWatchOverrides> },
  ): Promise<PrWatchSettingsBundle> => watcher.saveSettings(bundle),
);
ipcMain.handle('pr-watch:triage', async (_event, key: string): Promise<void> => watcher.triage(key));
ipcMain.handle(
  'pr-watch:revise',
  async (_event, key: string, options?: { task?: string; action?: 'RERUN_IMPLEMENTATION' | 'RERUN_PLANNING' }) =>
    watcher.revise(key, options ?? {}),
);
ipcMain.handle('pr-watch:dismiss', async (_event, key: string): Promise<void> => watcher.dismiss(key));
ipcMain.handle('pr-watch:post-replies', async (_event, key: string): Promise<void> => watcher.postReplies(key));
ipcMain.handle('pr-watch:approve', async (_event, key: string, headSha: string): Promise<void> => watcher.approve(key, headSha));
ipcMain.handle('pr-watch:withdraw-approval', async (_event, key: string): Promise<void> => watcher.withdrawApproval(key));
ipcMain.handle('pr-watch:merge-draft', async (_event, key: string): Promise<PrMergeDraft> => watcher.draftMerge(key));
ipcMain.handle(
  'pr-watch:merge',
  async (_event, key: string, input: { subject: string; body: string; deleteBranch: boolean }): Promise<PrMergeResult> =>
    watcher.merge(key, input),
);

// The delivery step registers a new pull request just before its process exits: look right away
// instead of waiting for the next poll.
runEvents.on('finished', () => watcher.poke());

app.whenReady().then(() => watcher.start());
app.on('before-quit', () => watcher.stop());
