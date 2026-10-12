/**
 * IPC handlers for factory operations (run, resume, list).
 */
import { ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import type { FactoryRun } from '../../shared/types';
import { ensureClaudeAuth } from '../services/claude-auth.js';
import { mainWindow } from '../main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the factory CLI (now in factory/ subdirectory)
const factoryCLI = path.join(__dirname, '../../../factory/src/cli/factory.ts');

// Active run processes
const activeRuns = new Map<string, ReturnType<typeof spawn>>();

/**
 * Run a factory task
 */
ipcMain.handle('factory:run', async (_event, params: {
  repoPath: string;
  task: string;
  criteria?: string[];
  maxAttempts?: number;
  branch?: string;
}): Promise<{ runId: string }> => {
  // Ensure auth first (auto-login if needed)
  const authenticated = await ensureClaudeAuth();
  if (!authenticated) {
    throw new Error('Authentication required. Please log in to Claude CLI.');
  }

  // Build CLI args
  const args = [
    factoryCLI,
    'run',
    '--repo', params.repoPath,
    '--task', params.task,
  ];

  if (params.criteria && params.criteria.length > 0) {
    args.push('--criteria', params.criteria.join(';'));
  }
  if (params.maxAttempts) {
    args.push('--max-attempts', String(params.maxAttempts));
  }
  if (params.branch) {
    args.push('--branch', params.branch);
  }

  // Spawn the factory process
  const proc = spawn('npx', ['tsx', ...args], {
    env: {
      ...process.env,
      FACTORY_PROVIDER: 'claude-cli',
      FACTORY_NON_INTERACTIVE: 'true',
      FACTORY_ALLOW_PUSH: 'false',
      FACTORY_ALLOW_PR: 'false',
    },
    cwd: path.join(__dirname, '../../../factory'),
  });

  // Extract runId from output
  let runId = '';
  let buffer = '';

  proc.stdout?.on('data', (data) => {
    buffer += data.toString();
    
    // Try to extract runId from the output
    const match = buffer.match(/Factory run ([\w-]+)/);
    if (match && !runId) {
      runId = match[1];
      activeRuns.set(runId, proc);
    }

    // Send output to renderer for real-time display
    if (runId) {
      mainWindow?.webContents.send('factory:output', runId, data.toString());
    }
  });

  proc.stderr?.on('data', (data) => {
    if (runId) {
      mainWindow?.webContents.send('factory:output', runId, data.toString());
    }
  });

  proc.on('close', (code) => {
    if (runId) {
      activeRuns.delete(runId);
      mainWindow?.webContents.send('factory:completed', runId, code);
    }
  });

  // Wait for runId to be extracted (with timeout)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Failed to start factory run')), 10000);
    
    const checkRunId = setInterval(() => {
      if (runId) {
        clearTimeout(timeout);
        clearInterval(checkRunId);
        resolve();
      }
    }, 100);
  });

  return { runId };
});

/**
 * Resume a suspended run
 */
ipcMain.handle('factory:resume', async (_event, params: {
  runId: string;
  decision?: 'ACKNOWLEDGE' | 'ABORT';
  guidance?: string;
  clarifications?: string;
}): Promise<void> => {
  const args = [factoryCLI, 'resume', '--run-id', params.runId];

  if (params.decision) {
    args.push('--decision', params.decision);
  }
  if (params.guidance) {
    args.push('--guidance', params.guidance);
  }
  if (params.clarifications) {
    args.push('--clarifications', params.clarifications);
  }

  const proc = spawn('npx', ['tsx', ...args], {
    env: {
      ...process.env,
      FACTORY_PROVIDER: 'claude-cli',
      FACTORY_NON_INTERACTIVE: 'true',
    },
    cwd: path.join(__dirname, '../../../factory'),
  });

  activeRuns.set(params.runId, proc);

  proc.stdout?.on('data', (data) => {
    mainWindow?.webContents.send('factory:output', params.runId, data.toString());
  });

  proc.on('close', (code) => {
    activeRuns.delete(params.runId);
    mainWindow?.webContents.send('factory:completed', params.runId, code);
  });
});

/**
 * List all runs (optionally filtered by repo)
 */
ipcMain.handle('factory:list', async (_event, repoPath?: string): Promise<FactoryRun[]> => {
  const logsDir = path.join(__dirname, '../../../logs'); // logs/ stays at monorepo root
  
  if (!fs.existsSync(logsDir)) {
    return [];
  }

  const runs: FactoryRun[] = [];
  const entries = fs.readdirSync(logsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const summaryPath = path.join(logsDir, entry.name, 'summary.json');
    if (!fs.existsSync(summaryPath)) continue;

    try {
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      
      // Filter by repo if specified
      if (repoPath && summary.repository !== repoPath) {
        continue;
      }

      runs.push({
        runId: summary.runId,
        repoId: path.basename(summary.repository),
        task: summary.task || '',
        status: summary.status,
        attempts: summary.attempts || 0,
        branch: summary.branch,
        startedAt: summary.startedAt || new Date().toISOString(),
        finishedAt: summary.finishedAt,
        tokens: summary.tokens,
        gates: summary.gates,
      });
    } catch {
      // Skip invalid summary files
    }
  }

  // Sort by startedAt descending
  runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  return runs;
});

/**
 * Get details of a specific run
 */
ipcMain.handle('factory:get', async (_event, runId: string): Promise<FactoryRun | null> => {
  const summaryPath = path.join(__dirname, '../../../logs', runId, 'summary.json');
  
  if (!fs.existsSync(summaryPath)) {
    return null;
  }

  try {
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    return {
      runId: summary.runId,
      repoId: path.basename(summary.repository),
      task: summary.task || '',
      status: summary.status,
      attempts: summary.attempts || 0,
      branch: summary.branch,
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
      tokens: summary.tokens,
      gates: summary.gates,
    };
  } catch {
    return null;
  }
});

/**
 * Cancel a running task
 */
ipcMain.handle('factory:cancel', async (_event, runId: string): Promise<void> => {
  const proc = activeRuns.get(runId);
  if (proc) {
    proc.kill('SIGTERM');
    activeRuns.delete(runId);
  }
});
