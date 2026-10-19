/**
 * IPC handlers for factory operations (run, resume, list).
 */
import { ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type {
  DeliveryEdits,
  FactoryRun,
  PendingInput,
  RunArtifact,
  RunEventRecord,
} from '../../shared/types';
import { readJson, readRunEvents as readEventsIn, readRunState as readRunStateIn } from '../services/run-state.js';
import { ensureClaudeAuth } from '../services/claude-auth.js';
import { mainWindow } from '../main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the factory CLI (now in factory/ subdirectory)
// Path to factory CLI - from dist-electron/ go up to studio/, then up to agent-software-factory/, then into factory/
const factoryCLI = path.join(__dirname, '../../factory/src/cli/factory.ts');

// Active run processes
const activeRuns = new Map<string, ReturnType<typeof spawn>>();

/**
 * Lifecycle events of factory processes, for services inside the main process. `finished` is the
 * cue for the pull-request watcher: the delivery step registers a new pull request just before
 * its process exits, so this is when a new one can be noticed without waiting for the next poll.
 */
export const runEvents = new EventEmitter();

/** Strips ANSI colour codes so the renderer receives plain text. */
function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\[([0-9;]+)m/g, '');
}

/* -------------------------------------------------------------------------- */
/* Run storage: where a run's state lives on disk                              */
/* -------------------------------------------------------------------------- */

/**
 * Factory logs live in factory/logs; from dist-electron that is ../../factory/logs.
 * `FACTORY_LOG_DIR` moves them for the factory, so the Studio has to follow - otherwise it would
 * read an empty directory while the factory writes somewhere else.
 */
const LOGS_DIR = process.env.FACTORY_LOG_DIR
  ? path.resolve(process.env.FACTORY_LOG_DIR)
  : path.join(__dirname, '../../factory/logs');

/** Directory of a run. `basename` keeps a crafted id from escaping the logs directory. */
const runDirOf = (runId: string): string => path.join(LOGS_DIR, path.basename(runId));

/** The factory's structured audit trail (`events.ndjson`) for a run. */
const readRunEvents = (runId: string): RunEventRecord[] => readEventsIn(runDirOf(runId));

/* -------------------------------------------------------------------------- */
/* Run output: persisted so a view that mounts later can replay it             */
/* -------------------------------------------------------------------------- */

/** Last console lines of each run, kept to explain a process that died without saying why. */
const recentOutput = new Map<string, string[]>();
const RECENT_OUTPUT_LIMIT = 60;
/** Output that arrived before the run directory existed (it is created by the factory). */
const unflushedOutput = new Map<string, string[]>();
/** Runs the user cancelled, so their exit is reported as a cancellation, not a crash. */
const cancelledRuns = new Set<string>();

function persistRunOutput(runId: string, line: string): void {
  try {
    const dir = runDirOf(runId);
    // The factory creates the directory a moment after the process starts. Hold the first lines
    // until it exists, rather than creating stray directories for ids that are not runs.
    if (!fs.existsSync(dir)) {
      const queued = unflushedOutput.get(runId) ?? [];
      queued.push(line);
      unflushedOutput.set(runId, queued);
      return;
    }
    const queued = unflushedOutput.get(runId);
    unflushedOutput.delete(runId);
    const chunk = queued ? [...queued, line] : [line];
    fs.appendFileSync(path.join(dir, 'output.log'), `${chunk.join('\n')}\n`, 'utf8');
  } catch {
    // Persisting is best effort: the live push still reaches the UI.
  }
}

/**
 * The single place a console line reaches the UI: persisted to `output.log` in the run
 * directory, then pushed live. Persisting first is what lets the pipeline view recover its
 * logs after the user switches repository and comes back.
 */
function emitRunOutput(runId: string, line: string): void {
  persistRunOutput(runId, line);

  const tail = recentOutput.get(runId) ?? [];
  tail.push(line);
  if (tail.length > RECENT_OUTPUT_LIMIT) tail.shift();
  recentOutput.set(runId, tail);

  mainWindow?.webContents.send('factory:output', runId, line);
}

/** A stack frame (`    at foo (file:1:2)`) is never the reason a run failed. */
const isStackFrame = (line: string): boolean => /^\s*(ERROR: )?\s*at\s/.test(line);

/** The last line a process printed that is not a stack frame - the closest thing to its reason. */
function lastMeaningfulLine(runId: string): string | undefined {
  const meaningful = (recentOutput.get(runId) ?? []).filter((line) => !isStackFrame(line));
  const lastError = [...meaningful].reverse().find((line) => line.startsWith('ERROR: '));
  const line = (lastError ?? meaningful[meaningful.length - 1] ?? '').replace(/^ERROR: /, '').trim();
  return line || undefined;
}

/**
 * Safety net for a factory process that died hard (killed, crashed before it could write its own
 * failure summary): keep the tail of its output so the UI can show a reason instead of
 * "interrupted or crashed". The CLI normally records failures itself, and then this does nothing.
 */
function recordProcessFailure(runId: string, exitCode: number | null, message?: string): void {
  try {
    const dir = runDirOf(runId);
    if (!fs.existsSync(dir)) return; // nothing to attach it to (e.g. a PR-feedback triage)

    const summary = readJson<{ status?: string; error?: string }>(path.join(dir, 'summary.json'));
    if (summary?.status && summary.status !== 'FAILED') return; // it finished: not a failure
    if (summary?.status === 'FAILED' && summary.error) return; // the CLI already explained itself

    const tail = recentOutput.get(runId) ?? [];
    const meaningful = tail.filter((line) => !isStackFrame(line));
    const lastError = [...meaningful].reverse().find((line) => line.startsWith('ERROR: '));
    const reason = cancelledRuns.has(runId)
      ? 'The run was cancelled.'
      : (message ??
        (lastError ?? meaningful[meaningful.length - 1] ?? '').replace(/^ERROR: /, '').trim()) ||
        `The factory process exited unexpectedly (exit code ${exitCode}).`;

    fs.writeFileSync(
      path.join(dir, 'failure.json'),
      `${JSON.stringify({ at: new Date().toISOString(), exitCode, message: reason, tail: tail.slice(-30) }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // Best effort.
  }
}

/**
 * Writes output that was held back because the run directory did not exist yet. A run that fails
 * before the workflow starts only gets its directory when the CLI writes its failure summary,
 * i.e. at the very end - without this its whole log would be thrown away.
 */
function flushQueuedOutput(runId: string): void {
  const queued = unflushedOutput.get(runId);
  if (!queued || queued.length === 0) return;
  try {
    const dir = runDirOf(runId);
    if (!fs.existsSync(dir)) return;
    fs.appendFileSync(path.join(dir, 'output.log'), `${queued.join('\n')}\n`, 'utf8');
    unflushedOutput.delete(runId);
  } catch {
    // Best effort.
  }
}

/** A factory process ended: update bookkeeping, record a hard failure, tell the renderer. */
function finishRunProcess(runId: string, code: number | null): void {
  activeRuns.delete(runId);
  flushQueuedOutput(runId);
  const exit = code ?? 1;
  // Exit 0 = done, 3 = suspended for a human; anything else is a failure to explain.
  const failed = exit !== 0 && exit !== 3;
  if (failed) recordProcessFailure(runId, exit);
  // The renderer shows this for processes that have no run directory of their own (a PR-feedback
  // triage), where there is no summary.json to read the reason from.
  const reason = failed ? lastMeaningfulLine(runId) : undefined;
  recentOutput.delete(runId);
  unflushedOutput.delete(runId);
  cancelledRuns.delete(runId);
  mainWindow?.webContents.send('factory:completed', runId, exit, reason);
  runEvents.emit('finished', runId, exit);
}

/** The process could not even start (spawn error). */
function failRunProcess(runId: string, message: string): void {
  activeRuns.delete(runId);
  recordProcessFailure(runId, null, message);
  recentOutput.delete(runId);
  unflushedOutput.delete(runId);
  mainWindow?.webContents.send('factory:error', runId, message);
  runEvents.emit('finished', runId, 1);
}

/**
 * A pull-request feedback triage. It has a trace directory like a run, but it is a read-only helper
 * the watcher starts on its own - listing it would bury the user's tasks in entries they never
 * created. (The task-text test covers directories written before triages marked themselves.)
 */
const isTriageRun = (run: { kind?: string; task: string }): boolean =>
  run.kind === 'pr-feedback' || run.task.startsWith('PR feedback triage for #');

/** State of a run derived from everything it left on disk (see `services/run-state.ts`). */
const readRunState = (runId: string) =>
  readRunStateIn(runDirOf(runId), runId, activeRuns.has(runId));

/** Last bytes kept of a command's output: enough to find its result line, bounded in memory. */
const CLI_OUTPUT_CAP = 2_000_000;

/**
 * Runs a factory CLI command to completion and returns what it printed. For short commands whose
 * result is read from a marker line (`pr-check`, `pr-dismiss`) and for the PR triage, which is a
 * single agent call with nothing to stream.
 */
export function runFactoryCli(
  cliArgs: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const factoryDir = path.resolve(__dirname, '../../factory');
  const tsxPath = path.join(path.resolve(__dirname, '../..'), 'node_modules/.bin/tsx');

  return new Promise((resolve) => {
    const proc = spawn('node', [tsxPath, factoryCLI, ...cliArgs], {
      env: { ...process.env, FACTORY_PROVIDER: 'claude-cli' },
      cwd: factoryDir,
    });
    let stdout = '';
    let stderr = '';
    const keepTail = (text: string) => (text.length > CLI_OUTPUT_CAP ? text.slice(-CLI_OUTPUT_CAP) : text);
    const timer = setTimeout(() => proc.kill('SIGTERM'), options.timeoutMs ?? 300_000);

    proc.stdout?.on('data', (data) => (stdout = keepTail(stdout + data.toString())));
    proc.stderr?.on('data', (data) => (stderr = keepTail(stderr + data.toString())));
    proc.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) });
    });
  });
}

const samePath = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

/**
 * A run that is using this repository's working copy: either a process of this app that is still
 * going, or a run parked at a human gate (its branch is checked out here, and resuming it would
 * commit onto whatever branch another run switched to).
 */
export function findBusyRun(
  repoPath: string,
): { runId: string; reason: 'running' | 'waiting'; task?: string } | null {
  for (const runId of activeRuns.keys()) {
    const state = readRunState(runId);
    // Just spawned: its repository is not known yet. Assume it is this one rather than collide.
    if (!state) return { runId, reason: 'running' };
    if (state.repoPath && samePath(state.repoPath, repoPath)) {
      return { runId, reason: 'running', ...(state.run.task ? { task: state.run.task } : {}) };
    }
  }

  if (!fs.existsSync(LOGS_DIR)) return null;
  for (const entry of fs.readdirSync(LOGS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!fs.existsSync(path.join(LOGS_DIR, entry.name, 'pending-input.json'))) continue;
    const state = readRunState(entry.name);
    if (state && state.repoPath && samePath(state.repoPath, repoPath) && state.run.kind !== 'pr-feedback') {
      return { runId: entry.name, reason: 'waiting', ...(state.run.task ? { task: state.run.task } : {}) };
    }
  }
  return null;
}

/** Is a process of this app still going for the run? (A run's directory outlives its process.) */
export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

/** The rounds of one pull request (newest first), found among the runs created after its first run. */
export function listRoundsOf(
  repoPath: string,
  number: number,
  sinceRunId: string,
): Array<{ runId: string; round: number; status: string; error?: string; waitingFor?: string }> {
  if (!fs.existsSync(LOGS_DIR)) return [];
  const rounds: Array<{ runId: string; round: number; status: string; error?: string; waitingFor?: string }> = [];

  // Run ids start with a timestamp, so "created after" is a plain string comparison.
  for (const name of fs.readdirSync(LOGS_DIR).filter((n) => n > sinceRunId)) {
    const meta = readJson<{ kind?: string; round?: number; repoPath?: string; pullRequest?: { number?: number } }>(
      path.join(LOGS_DIR, name, 'run.json'),
    );
    if (!meta || meta.kind !== 'revision' || meta.pullRequest?.number !== number) continue;
    if (!meta.repoPath || !samePath(meta.repoPath, repoPath)) continue;

    const state = readRunState(name);
    if (!state) continue;
    const pending = readJson<{ reason?: string }>(path.join(LOGS_DIR, name, 'pending-input.json'));
    rounds.push({
      runId: name,
      round: meta.round ?? 2,
      status: state.run.status,
      ...(state.run.error ? { error: state.run.error } : {}),
      ...(pending?.reason ? { waitingFor: pending.reason } : {}),
    });
  }
  return rounds.sort((a, b) => b.runId.localeCompare(a.runId));
}

export { LOGS_DIR, factoryCLI };

/**
 * Spawns the factory CLI and streams its output to the renderer as `factory:output` events.
 *
 * Must use the system `node` with the tsx loader (not Electron's bundled node) and no shell,
 * otherwise the CLI cannot resolve its TypeScript entrypoint.
 */
function spawnFactoryStreaming(runId: string, args: string[]): void {
  const factoryDir = path.resolve(__dirname, '../../factory');
  const rootDir = path.resolve(__dirname, '../..');
  const tsxPath = path.join(rootDir, 'node_modules/.bin/tsx');

  const proc = spawn('node', [tsxPath, ...args], {
    env: {
      ...process.env,
      FACTORY_NON_INTERACTIVE: 'true',
      FACTORY_PROVIDER: 'claude-cli',
    },
    cwd: factoryDir,
  });

  activeRuns.set(runId, proc);

  // stdout arrives in arbitrary chunks; buffer until a newline so the UI gets whole lines.
  let stdoutBuffer = '';
  let stderrBuffer = '';

  proc.stdout?.on('data', (data) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      const clean = stripAnsi(line).trim();
      if (clean) emitRunOutput(runId, clean);
    }
  });

  proc.stderr?.on('data', (data) => {
    stderrBuffer += data.toString();
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() || '';
    for (const line of lines) {
      const clean = stripAnsi(line).trim();
      if (clean) emitRunOutput(runId, `ERROR: ${clean}`);
    }
  });

  proc.on('error', (error) => {
    failRunProcess(runId, error.message);
  });

  proc.on('close', (code) => {
    finishRunProcess(runId, code);
  });
}

/**
 * List available repositories in the workspace
 */
ipcMain.handle('factory:list-repos', async (): Promise<Array<{ name: string; path: string; recentRuns: number }>> => {
  const logsDir = LOGS_DIR;

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
 * Remove a repository from saved repositories
 */
ipcMain.handle('factory:remove-repo', async (_event, repoName: string): Promise<void> => {
  const { loadSettings, saveSettings } = await import('./settings.js');
  const settings = loadSettings();
  
  if (settings.global.savedRepositories) {
    settings.global.savedRepositories = settings.global.savedRepositories.filter(
      r => r.name !== repoName
    );
    saveSettings(settings);
  }
});

/**
 * Starts a factory process (`run`, `revise`, ...) that creates its own run, and resolves once the
 * run id it announces is known. Output is streamed to the renderer and persisted exactly like a
 * run the user started by hand, which is what lets a round started in the background be opened
 * and followed like any other.
 *
 * Interactive on purpose (no FACTORY_NON_INTERACTIVE): the Studio can show the human input gates.
 */
export async function startFactoryRun(cliArgs: string[]): Promise<{ runId: string }> {
  const args = [factoryCLI, ...cliArgs];
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
      // Studio IS interactive - it can show human input panels for approval gates
      // So we don't set FACTORY_NON_INTERACTIVE here
      FACTORY_PROVIDER: 'claude-cli', // Use Claude Pro subscription via CLI
    },
    cwd: factoryDir,
  });

  // Extract runId from output
  let runId = '';
  let runIdBuffer = '';
  let stdoutLineBuffer = '';
  let stderrLineBuffer = '';

  // Helper to strip ANSI color codes for cleaner display
  const stripAnsi = (str: string) => str
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')  // Standard ANSI escape sequences
    .replace(/\[([0-9;]+)m/g, '');           // Bare color codes without ESC

  proc.stdout?.on('data', (data) => {
    const chunk = data.toString();
    runIdBuffer += chunk;
    console.log('[Factory stdout]', chunk);
    
    // Try to extract runId from the accumulated output
    const match = runIdBuffer.match(/Factory run ([\w-]+)/);
    if (match && !runId) {
      runId = match[1];
      activeRuns.set(runId, proc);
      console.log('[Factory IPC] Extracted runId:', runId);
    }

    // Send complete lines to renderer for real-time display
    if (runId) {
      stdoutLineBuffer += chunk;
      const lines = stdoutLineBuffer.split('\n');
      stdoutLineBuffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const cleanLine = stripAnsi(line).trim();
        if (cleanLine) {
          emitRunOutput(runId, cleanLine);
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
          emitRunOutput(runId, `ERROR: ${cleanLine}`);
        }
      }
    }
  });

  proc.on('close', (code) => {
    console.log('[Factory] Process closed with code:', code);
    if (runId) finishRunProcess(runId, code);
  });

  proc.on('error', (error) => {
    console.error('[Factory] Process error:', error);
    if (runId) failRunProcess(runId, error.message);
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
}

/**
 * Run a task on a repository (simplified interface)
 */
ipcMain.handle('factory:run-task', async (_event, params: {
  repo: string;
  task: string;
  maxAttempts?: number;
  dryRun?: boolean;
  pipeline?: { qa?: boolean; review?: boolean; security?: boolean; documentation?: boolean };
}): Promise<{ runId: string }> => {
  // Ensure auth first
  const authenticated = await ensureClaudeAuth();
  if (!authenticated) {
    throw new Error('Authentication required. Please log in to Claude CLI.');
  }

  // Build CLI args
  const args = [
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

  // Pipeline configuration flags
  if (params.pipeline) {
    if (params.pipeline.qa === false) args.push('--no-qa');
    if (params.pipeline.review === false) args.push('--no-review');
    if (params.pipeline.security === false) args.push('--no-security');
    if (params.pipeline.documentation === false) args.push('--no-docs');
  }

  return await startFactoryRun(args);
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
  // Matches ESC[ followed by any params and ending character, plus common color codes like [32m
  const stripAnsi = (str: string) => str
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')  // Standard ANSI escape sequences
    .replace(/\[([0-9;]+)m/g, '');           // Bare color codes without ESC (sometimes appear)

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
          emitRunOutput(runId, cleanLine);
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
          emitRunOutput(runId, `ERROR: ${cleanLine}`);
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
  step?: string;
}): Promise<void> => {
  const authenticated = await ensureClaudeAuth();
  if (!authenticated) {
    throw new Error('Authentication required. Please log in to Claude CLI.');
  }

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
  if (params.step) {
    args.push('--step', params.step);
  }

  // Use system node (not Electron's) to run the factory via tsx, same as `run`.
  const factoryDir = path.resolve(__dirname, '../../factory');
  const rootDir = path.resolve(__dirname, '../..');
  const tsxPath = path.join(rootDir, 'node_modules/.bin/tsx');

  const proc = spawn('node', [tsxPath, ...args], {
    env: {
      ...process.env,
      FACTORY_NON_INTERACTIVE: 'true',
      FACTORY_PROVIDER: 'claude-cli',
    },
    cwd: factoryDir,
  });

  const runId = params.runId;
  activeRuns.set(runId, proc);

  const stripAnsi = (str: string) => str
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\[([0-9;]+)m/g, '');

  let stdoutLineBuffer = '';
  let stderrLineBuffer = '';

  proc.stdout?.on('data', (data) => {
    const chunk = data.toString();
    console.log('[Factory resume stdout]', chunk);
    stdoutLineBuffer += chunk;
    const lines = stdoutLineBuffer.split('\n');
    stdoutLineBuffer = lines.pop() || '';
    for (const line of lines) {
      const cleanLine = stripAnsi(line).trim();
      if (cleanLine) emitRunOutput(runId, cleanLine);
    }
  });

  proc.stderr?.on('data', (data) => {
    const chunk = data.toString();
    console.log('[Factory resume stderr]', chunk);
    stderrLineBuffer += chunk;
    const lines = stderrLineBuffer.split('\n');
    stderrLineBuffer = lines.pop() || '';
    for (const line of lines) {
      const cleanLine = stripAnsi(line).trim();
      if (cleanLine) emitRunOutput(runId, `ERROR: ${cleanLine}`);
    }
  });

  proc.on('error', (error) => {
    console.error('[Factory resume] Process error:', error);
    failRunProcess(runId, error.message);
  });

  proc.on('close', (code) => {
    console.log('[Factory resume] Process closed with code:', code);
    finishRunProcess(runId, code);
  });
});

/**
 * List all runs (optionally filtered by repo)
 */
ipcMain.handle('factory:list', async (_event, repoPath?: string): Promise<FactoryRun[]> => {
  if (!fs.existsSync(LOGS_DIR)) return [];

  const runs: FactoryRun[] = [];
  for (const entry of fs.readdirSync(LOGS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const state = readRunState(entry.name);
    if (!state) continue; // not a run directory
    if (isTriageRun(state.run)) continue; // background plumbing, not a task the user ran
    if (repoPath && state.repoPath !== repoPath) continue;

    // The list only needs the headline fields.
    const { steps: _steps, ...headline } = state.run;
    runs.push(headline);
  }

  runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return runs;
});

/**
 * Get details of a specific run
 */
ipcMain.handle('factory:get', async (_event, runId: string): Promise<FactoryRun | null> => {
  return readRunState(runId)?.run ?? null;
});

/**
 * Every round of one task - the run itself and each revision of it - oldest first, so the pipeline
 * view can offer "Round 1 / Round 2 / ..." and the history can show them together.
 */
ipcMain.handle('factory:get-rounds', async (_event, runId: string) => {
  const self = readRunState(runId);
  if (!self) return [];
  const root = self.run.rootRunId ?? runId;
  if (!fs.existsSync(LOGS_DIR)) return [];

  const rounds: Array<{ runId: string; round: number; status: FactoryRun['status']; startedAt: string; kind: string }> = [];
  // Rounds are created after the run they continue, so nothing older than the root can belong to it.
  for (const name of fs.readdirSync(LOGS_DIR).filter((n) => n >= root)) {
    const state = readRunState(name);
    if (!state || isTriageRun(state.run)) continue;
    if ((state.run.rootRunId ?? name) !== root) continue;
    rounds.push({
      runId: name,
      round: state.run.round ?? 1,
      status: state.run.status,
      startedAt: state.run.startedAt,
      kind: state.run.kind ?? 'run',
    });
  }
  return rounds.sort((a, b) => a.round - b.round || a.startedAt.localeCompare(b.startedAt));
});

/**
 * The factory's structured audit trail: human answers, suspensions, delivery actions.
 */
ipcMain.handle('factory:get-events', async (_event, runId: string): Promise<RunEventRecord[]> => {
  return readRunEvents(runId);
});

/** Lines returned on the first read of a run's output (later reads are incremental). */
const OUTPUT_REPLAY_LIMIT = 2000;

/**
 * Console output of a run, as persisted by `emitRunOutput`.
 *
 * `fromLine` makes polling incremental: pass the `total` of the previous call to get only what
 * is new. Without it the most recent lines are returned, which is what a view that has just
 * mounted (repo switch, opening a finished run) needs to catch up.
 */
ipcMain.handle(
  'factory:get-output',
  async (_event, runId: string, fromLine?: number): Promise<{ lines: string[]; total: number }> => {
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(path.join(runDirOf(runId), 'output.log'), 'utf8').split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
    } catch {
      // No output persisted yet.
    }
    const total = lines.length;
    const start =
      fromLine === undefined
        ? Math.max(0, total - OUTPUT_REPLAY_LIMIT)
        : Math.min(Math.max(0, fromLine), total);
    return { lines: lines.slice(start), total };
  },
);

/**
 * Get the agent artifacts (rich step outputs) for a run.
 * Reads the numbered artifact JSON files written by each agent.
 */
ipcMain.handle('factory:get-artifacts', async (_event, runId: string): Promise<RunArtifact[]> => {
  const runDir = runDirOf(runId);

  if (!fs.existsSync(runDir)) {
    return [];
  }

  const artifacts: RunArtifact[] = [];

  try {
    const files = fs
      .readdirSync(runDir)
      .filter((f) => /^\d{2}-.*\.json$/.test(f))
      .sort();

    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(runDir, file), 'utf8'));
        artifacts.push({
          step: raw.step,
          attempt: raw.attempt ?? 1,
          status: raw.status,
          model: raw.model,
          durationMs: raw.durationMs,
          writtenAt: raw.writtenAt,
          data: raw.data ?? {},
        });
      } catch {
        // Skip corrupt artifact files
      }
    }
  } catch {
    return [];
  }

  return artifacts;
});

/**
 * Read the open human-in-the-loop request for a run, if any.
 * The workflow mirrors its suspend payload to `pending-input.json` while it waits.
 */
ipcMain.handle('factory:get-pending-input', async (_event, runId: string): Promise<PendingInput | null> => {
  const filePath = path.join(runDirOf(runId), 'pending-input.json');

  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as PendingInput;
  } catch {
    return null;
  }
});

/**
 * Answer a human-in-the-loop gate: resumes the run with the collected decision.
 */
ipcMain.handle('factory:submit-input', async (_event, params: {
  runId: string;
  clarifications?: string;
  decision?: 'ACKNOWLEDGE' | 'ABORT';
  guidance?: string;
  approvePush?: boolean;
  approvePullRequest?: boolean;
  edits?: DeliveryEdits;
}): Promise<void> => {
  const args = [factoryCLI, 'resume', '--run-id', params.runId];

  if (params.clarifications !== undefined) {
    args.push('--clarifications', params.clarifications);
  } else if (params.approvePush !== undefined) {
    args.push('--approve-push', String(params.approvePush));
    args.push('--approve-pr', String(params.approvePullRequest ?? false));
    // One JSON value (always starts with "{"), so it can never be mistaken for a flag even if a
    // commit message or description begins with "--".
    if (params.edits && Object.keys(params.edits).length > 0) {
      args.push('--edits', JSON.stringify(params.edits));
    }
  } else if (params.decision !== undefined) {
    args.push('--decision', params.decision);
    if (params.guidance) args.push('--guidance', params.guidance);
  }

  await spawnFactoryStreaming(params.runId, args);
});

/**
 * Delete a run and all its artifacts from disk
 */
ipcMain.handle('factory:delete', async (_event, runId: string): Promise<void> => {
  const runDir = runDirOf(runId);
  
  if (!fs.existsSync(runDir)) {
    throw new Error(`Run ${runId} not found`);
  }

  // Cannot delete running runs
  const proc = activeRuns.get(runId);
  if (proc) {
    throw new Error('Cannot delete a running task. Cancel it first.');
  }

  // Recursively delete the run directory
  fs.rmSync(runDir, { recursive: true, force: true });
  console.log('[Factory IPC] Deleted run:', runId);
});

/**
 * Cancel a running task
 */
ipcMain.handle('factory:cancel', async (_event, runId: string): Promise<void> => {
  const proc = activeRuns.get(runId);
  if (proc) {
    // Remember that this exit is deliberate, so it is reported as a cancellation, not a crash.
    cancelledRuns.add(runId);
    proc.kill('SIGTERM');
  }
});
