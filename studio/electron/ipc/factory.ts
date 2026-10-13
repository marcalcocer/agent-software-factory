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
// Path to factory CLI - from dist-electron/ go up to studio/, then up to agent-software-factory/, then into factory/
const factoryCLI = path.join(__dirname, '../../factory/src/cli/factory.ts');

// Active run processes
const activeRuns = new Map<string, ReturnType<typeof spawn>>();

/**
 * List available repositories in the workspace
 */
ipcMain.handle('factory:list-repos', async (): Promise<Array<{ name: string; path: string; recentRuns: number }>> => {
  // From dist-electron/ -> studio/ -> agent-software-factory/
  const workspaceRoot = path.join(__dirname, '../../');
  const logsDir = path.join(workspaceRoot, 'logs');
  
  const repos: Map<string, { name: string; path: string; recentRuns: number }> = new Map();

  // Load saved repositories from settings
  const { loadSettings } = await import('./settings.js');
  const settings = loadSettings();
  
  if (settings.global.savedRepositories) {
    for (const savedRepo of settings.global.savedRepositories) {
      repos.set(savedRepo.name, {
        name: savedRepo.name,
        path: savedRepo.path,
        recentRuns: 0,
      });
    }
  }

  // Scan logs directory for recent runs to get repo names and run counts
  if (fs.existsSync(logsDir)) {
    const entries = fs.readdirSync(logsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const summaryPath = path.join(logsDir, entry.name, 'summary.json');
      if (!fs.existsSync(summaryPath)) continue;
      
      try {
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        const repoName = path.basename(summary.repository);
        
        if (!repos.has(repoName)) {
          repos.set(repoName, {
            name: repoName,
            path: summary.repository,
            recentRuns: 0,
          });
        }
        
        const repo = repos.get(repoName)!;
        repo.recentRuns += 1;
      } catch {
        // Skip invalid entries
      }
    }
  }

  return Array.from(repos.values()).sort((a, b) => b.recentRuns - a.recentRuns);
});

/**
 * Run a task on a repository (simplified interface)
 */
ipcMain.handle('factory:run-task', async (_event, params: {
  repo: string;
  task: string;
  maxAttempts?: number;
  dryRun?: boolean;
}): Promise<{ runId: string }> => {
  // Ensure auth first
  const authenticated = await ensureClaudeAuth();
  if (!authenticated) {
    throw new Error('Authentication required. Please log in to Claude CLI.');
  }

  // Build CLI args
  const args = [
    factoryCLI,
    'run',
    '--repo', params.repo,
    '--task', params.task,
  ];

  if (params.maxAttempts) {
    args.push('--max-attempts', String(params.maxAttempts));
  }
  if (params.dryRun) {
    args.push('--dry-run');
  }

  console.log('[Factory IPC] Running factory with args:', args);

  // Get the factory directory - handle both dev and production paths
  const factoryDir = path.resolve(__dirname, '../../factory');
  console.log('[Factory IPC] Factory directory:', factoryDir);

  // Use system node (not Electron's) to run the factory via tsx
  // tsx is in the monorepo root's node_modules (workspace structure)
  const rootDir = path.resolve(__dirname, '../..');
  const tsxPath = path.join(rootDir, 'node_modules/.bin/tsx');
  
  // Build the command: node ../node_modules/.bin/tsx factory.ts run --repo ... --task ...
  const proc = spawn('node', [tsxPath, ...args], {
    env: {
      ...process.env,
      FACTORY_NON_INTERACTIVE: 'true',
      FACTORY_PROVIDER: 'claude-cli', // Use Claude Pro subscription via CLI
    },
    cwd: factoryDir,
  });

  // Extract runId from output
  let runId = '';
  let buffer = '';

  proc.stdout?.on('data', (data) => {
    const text = data.toString();
    buffer += text;
    console.log('[Factory stdout]', text);
    
    // Try to extract runId from the output
    const match = buffer.match(/Factory run ([\w-]+)/);
    if (match && !runId) {
      runId = match[1];
      activeRuns.set(runId, proc);
      console.log('[Factory IPC] Extracted runId:', runId);
    }

    // Send output to renderer for real-time display
    if (runId) {
      mainWindow?.webContents.send('factory:output', runId, text);
    }
  });

  proc.stderr?.on('data', (data) => {
    const text = data.toString();
    console.log('[Factory stderr]', text);
    if (runId) {
      mainWindow?.webContents.send('factory:output', runId, text);
    }
  });

  proc.on('close', (code) => {
    console.log('[Factory] Process closed with code:', code);
    if (runId) {
      activeRuns.delete(runId);
      mainWindow?.webContents.send('factory:completed', runId, code);
    }
  });

  proc.on('error', (error) => {
    console.error('[Factory] Process error:', error);
    if (runId) {
      mainWindow?.webContents.send('factory:error', runId, error.message);
    }
  });

  // Wait for runId to be extracted (with timeout)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!runId) {
        proc.kill();
        reject(new Error('Failed to start factory run - no runId generated'));
      }
    }, 15000);
    
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
    cwd: path.join(__dirname, '../../factory'),
  });

  // Extract runId from output
  let runId = '';
  let runIdBuffer = '';
  let stdoutLineBuffer = '';
  let stderrLineBuffer = '';

  // Helper to strip ANSI color codes for cleaner display
  const stripAnsi = (str: string) => str.replace(/\x1B\[[0-9;]*[JKmsu]/g, '');

  proc.stdout?.on('data', (data) => {
    const chunk = data.toString();
    runIdBuffer += chunk;
    console.log('[Factory stdout]', chunk);
    
    // Try to extract runId from the accumulated output
    const match = runIdBuffer.match(/Factory run ([\w-]+)/);
    if (match && !runId) {
      runId = match[1];
      console.log('[Factory IPC] Extracted runId:', runId);
      activeRuns.set(runId, proc);
    }

    // Send complete lines to renderer for real-time display
    if (runId) {
      stdoutLineBuffer += chunk;
      const lines = stdoutLineBuffer.split('\n');
      // Keep the last incomplete line in buffer
      stdoutLineBuffer = lines.pop() || '';

      // Send each complete line
      for (const line of lines) {
        const cleanLine = stripAnsi(line).trim();
        if (cleanLine) {
          mainWindow?.webContents.send('factory:output', runId, cleanLine);
        }
      }
    }
  });

  proc.stderr?.on('data', (data) => {
    const chunk = data.toString();
    console.log('[Factory stderr]', chunk);
    
    if (runId) {
      stderrLineBuffer += chunk;
      const lines = stderrLineBuffer.split('\n');
      stderrLineBuffer = lines.pop() || '';

      for (const line of lines) {
        const cleanLine = stripAnsi(line).trim();
        if (cleanLine) {
          mainWindow?.webContents.send('factory:output', runId, `ERROR: ${cleanLine}`);
        }
      }
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
    cwd: path.join(__dirname, '../../factory'),
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
  const logsDir = path.join(__dirname, '../../logs'); // logs/ at monorepo root
  
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
  const summaryPath = path.join(__dirname, '../../logs', runId, 'summary.json');
  
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
      steps: summary.steps || [],
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
