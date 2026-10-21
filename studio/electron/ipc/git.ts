/**
 * IPC handlers for git/repository operations.
 */
import { ipcMain, dialog } from 'electron';
import type { Repository } from '../../shared/types';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openRepositoryFolder } from '../services/repository-folder.js';
import { mainWindow } from '../main.js';

// In-memory repo list (TODO: persist to settings)
const repositories = new Map<string, Repository>();

ipcMain.handle('repo:list', async (): Promise<Repository[]> => {
  return Array.from(repositories.values()).sort((a, b) => 
    (b.lastAccessed || '').localeCompare(a.lastAccessed || '')
  );
});

/**
 * Open native folder picker dialog to select a repository
 */
ipcMain.handle('repo:browse', async (): Promise<Repository | null> => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Repository Folder',
    properties: ['openDirectory'],
    buttonLabel: 'Select Repository',
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  // The top folder of a git repository is added; anything else is refused with the reason, and not remembered.
  // The user sees the reason: the renderer shows what this throws.
  const { loadSettings, saveSettings } = await import('./settings.js');
  const repo = openRepositoryFolder(result.filePaths[0], { load: loadSettings, save: saveSettings });
  repositories.set(repo.name, repo);
  return repo;
});

ipcMain.handle('repo:add', async (_event, repoPath: string): Promise<Repository> => {
  const resolved = path.resolve(repoPath);
  
  if (!fs.existsSync(resolved)) {
    throw new Error(`Repository not found: ${resolved}`);
  }

  if (!fs.existsSync(path.join(resolved, '.git'))) {
    throw new Error(`Not a git repository: ${resolved}`);
  }

  const name = path.basename(resolved);
  const id = name; // Simple ID for now

  const repo: Repository = {
    id,
    name,
    path: resolved,
    lastAccessed: new Date().toISOString(),
  };

  repositories.set(id, repo);
  return repo;
});

ipcMain.handle('repo:remove', async (_event, id: string): Promise<void> => {
  repositories.delete(id);
});

ipcMain.handle('repo:select', async (_event, repoPath: string): Promise<void> => {
  const name = path.basename(repoPath);
  const repo = repositories.get(name);
  if (repo) {
    repo.lastAccessed = new Date().toISOString();
  }
});

ipcMain.handle('diff:get', async (_event, repoPath: string, _runId?: string): Promise<{ files: string[]; diff: string }> => {
  // TODO: If runId is provided, get diff from that run's branch
  // For now, get current working tree diff
  
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['diff', '--name-only'], { cwd: repoPath });
    let files = '';
    let diffOutput = '';

    proc.stdout.on('data', (data) => (files += data.toString()));
    proc.on('close', () => {
      // Get full diff
      const diffProc = spawn('git', ['diff'], { cwd: repoPath });
      diffProc.stdout.on('data', (data) => (diffOutput += data.toString()));
      diffProc.on('close', () => {
        resolve({
          files: files.split('\n').filter(Boolean),
          diff: diffOutput,
        });
      });
      diffProc.on('error', reject);
    });
    proc.on('error', reject);
  });
});

ipcMain.handle('logs:get', async (_event, runId: string): Promise<{ path: string; content: string }[]> => {
  const logsDir = path.join(__dirname, '../../../logs', runId);
  
  if (!fs.existsSync(logsDir)) {
    return [];
  }

  const files = fs.readdirSync(logsDir)
    .filter(f => f.endsWith('.json') || f.endsWith('.log'))
    .map(f => ({
      path: f,
      content: fs.readFileSync(path.join(logsDir, f), 'utf8'),
    }));

  return files;
});

ipcMain.handle('logs:tail', async (_event, runId: string, file: string): Promise<string> => {
  const filePath = path.join(__dirname, '../../../logs', runId, file);
  
  if (!fs.existsSync(filePath)) {
    return '';
  }

  const content = fs.readFileSync(filePath, 'utf8');
  // Return last 1000 lines
  return content.split('\n').slice(-1000).join('\n');
});
