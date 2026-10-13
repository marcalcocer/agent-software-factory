/**
 * Safe process execution for the factory tools.
 *
 * All command execution goes through this module so that three invariants hold everywhere:
 *   1. commands run with `shell: false` (no shell interpolation / command chaining),
 *   2. the executable is checked against the configured allow-list,
 *   3. stdout/stderr are always captured, truncated and returned with the exit code,
 *      never thrown away.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { getFactoryConfig } from './factory-config.ts';

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  ok: boolean;
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /** Max characters kept per stream (the tail is preserved: that is where failures are). */
  maxOutputChars?: number;
  /** Skip the allow-list check. Reserved for internal factory commands such as `git`. */
  trusted?: boolean;
  /** Input piped to stdin. */
  stdin?: string;
  /** Called with each stdout chunk as it arrives (for streaming LLM output). */
  onStdout?: (chunk: string) => void;
}

const FORBIDDEN_PATTERN = /[;&|`$><\n\r]|\|\||&&|\$\(/;

/** Thrown when a command is rejected before execution. */
export class CommandRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandRejectedError';
  }
}

/**
 * Splits a command line into tokens, honouring single and double quotes.
 * Shell metacharacters are rejected instead of being interpreted.
 */
export function tokenizeCommand(commandLine: string): string[] {
  const input = commandLine.trim();
  if (input === '') throw new CommandRejectedError('Empty command.');
  if (FORBIDDEN_PATTERN.test(input)) {
    throw new CommandRejectedError(
      `Command "${input}" contains shell control characters (; & | \` $ > < newline). ` +
        'Run a single command per call; chaining is not allowed.',
    );
  }

  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of input) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new CommandRejectedError(`Unbalanced quote in command: ${input}`);
  if (current !== '') tokens.push(current);
  return tokens;
}

/** Normalises an executable reference (`./mvnw`, `/usr/bin/mvn`) to its base name. */
function executableName(executable: string): string {
  return path.basename(executable);
}

/** Checks an executable against the configured allow-list. */
export function assertAllowedExecutable(executable: string): void {
  const { allowedCommands } = getFactoryConfig();
  const name = executableName(executable);
  const allowed = allowedCommands.some(
    (entry) => entry === executable || executableName(entry) === name,
  );
  if (!allowed) {
    throw new CommandRejectedError(
      `Executable "${executable}" is not allow-listed. Allowed: ${allowedCommands.join(', ')}. ` +
        'Extend it with FACTORY_EXTRA_ALLOWED_COMMANDS if the repository needs another runner.',
    );
  }
}

function truncate(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  const keep = Math.floor(maxChars / 2);
  const head = value.slice(0, keep);
  const tail = value.slice(-keep);
  return {
    text: `${head}\n\n[... ${value.length - 2 * keep} characters truncated ...]\n\n${tail}`,
    truncated: true,
  };
}

/** Spawns a process without a shell and returns a fully captured result. */
export async function runProcess(
  executable: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const config = getFactoryConfig();
  const timeoutMs = options.timeoutMs ?? config.commandTimeoutMs;
  const maxOutputChars = options.maxOutputChars ?? config.maxOutputChars;
  const cwd = path.resolve(options.cwd);

  if (!fs.existsSync(cwd)) {
    throw new CommandRejectedError(`Working directory does not exist: ${cwd}`);
  }
  if (!options.trusted) assertAllowedExecutable(executable);

  // Resolve wrapper scripts (./mvnw, ./gradlew) relative to the working directory.
  const resolvedExecutable =
    executable.startsWith('./') || executable.startsWith('../')
      ? path.resolve(cwd, executable)
      : executable;

  const startedAt = Date.now();

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(resolvedExecutable, args, {
      cwd,
      shell: false,
      env: { ...process.env, ...options.env, CI: process.env.CI ?? 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }

    child.on('error', (error) => {
      clearTimeout(timer);
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        resolve({
          command: resolvedExecutable,
          args,
          cwd,
          exitCode: 127,
          signal: null,
          stdout: '',
          stderr: `Executable not found: ${resolvedExecutable}`,
          durationMs: Date.now() - startedAt,
          timedOut: false,
          truncated: false,
          ok: false,
        });
        return;
      }
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const out = truncate(stdout, maxOutputChars);
      const err = truncate(stderr, maxOutputChars);
      const exitCode = timedOut ? 124 : (code ?? 1);
      resolve({
        command: resolvedExecutable,
        args,
        cwd,
        exitCode,
        signal: signal ?? null,
        stdout: out.text,
        stderr: timedOut
          ? `${err.text}\n[command timed out after ${timeoutMs} ms and was killed]`
          : err.text,
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated: out.truncated || err.truncated,
        ok: !timedOut && exitCode === 0,
      });
    });
  });
}

/** Runs a full command line (`"npm run test -- --watch=false"`) through the allow-list. */
export async function runCommandLine(
  commandLine: string,
  options: RunCommandOptions,
): Promise<CommandResult> {
  const [executable, ...args] = tokenizeCommand(commandLine);
  if (!executable) throw new CommandRejectedError('Empty command.');
  return await runProcess(executable, args, options);
}

/** Runs `git` with the given arguments. Git is always trusted but never shell-interpolated. */
export async function runGit(
  args: string[],
  options: Omit<RunCommandOptions, 'trusted'>,
): Promise<CommandResult> {
  return await runProcess('git', args, { ...options, trusted: true });
}

/** `true` when an executable is available on the PATH. */
export async function hasExecutable(executable: string, cwd: string): Promise<boolean> {
  try {
    const result = await runProcess('which', [executable], {
      cwd,
      trusted: true,
      timeoutMs: 10_000,
    });
    return result.ok;
  } catch {
    return false;
  }
}

/** Compact one-line summary of a command result, suitable for prompts and reports. */
export function summarizeResult(result: CommandResult): string {
  const status = result.timedOut ? 'TIMEOUT' : result.ok ? 'OK' : `EXIT ${result.exitCode}`;
  return `${[result.command, ...result.args].join(' ')} -> ${status} (${result.durationMs} ms)`;
}
