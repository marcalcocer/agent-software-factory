/**
 * Claude CLI authentication service - handles auto-login flow.
 */
import { spawn } from 'node:child_process';
import { mainWindow } from '../main.js';

export interface AuthStatus {
  type: 'ok' | 'auth' | 'not-installed' | 'error';
  message?: string;
}

/**
 * Check if Claude CLI is installed and authenticated.
 */
export async function checkClaudeAuth(): Promise<AuthStatus> {
  try {
    const result = await new Promise<{ exitCode: number; output: string }>((resolve) => {
      const proc = spawn('claude', ['-p', 'ok', '--output-format', 'json'], {
        timeout: 10000,
      });

      let output = '';
      proc.stdout?.on('data', (data) => (output += data.toString()));
      proc.stderr?.on('data', (data) => (output += data.toString()));

      proc.on('close', (code) => {
        resolve({ exitCode: code ?? 1, output });
      });

      proc.on('error', () => {
        resolve({ exitCode: 1, output: 'not-installed' });
      });
    });

    if (result.output.includes('not-installed') || result.output.includes('command not found')) {
      return { type: 'not-installed', message: 'Claude CLI is not installed' };
    }

    try {
      const parsed = JSON.parse(result.output);
      if (parsed.is_error) {
        const msg = parsed.result || '';
        if (msg.includes('OAuth session expired')) {
          return { type: 'auth', message: 'OAuth session expired' };
        }
        return { type: 'error', message: msg };
      }
      return { type: 'ok' };
    } catch {
      // Couldn't parse - likely an error
      if (result.output.includes('OAuth session expired')) {
        return { type: 'auth', message: 'OAuth session expired' };
      }
      return { type: 'error', message: result.output.slice(0, 200) };
    }
  } catch (error) {
    return { type: 'error', message: String(error) };
  }
}

/**
 * Trigger Claude login flow - opens browser automatically.
 * 
 * This is the auto-login improvement: instead of just showing an error,
 * we spawn `claude login` which opens the browser, and wait for completion.
 */
export async function triggerClaudeLogin(): Promise<boolean> {
  // Notify renderer that login is starting
  mainWindow?.webContents.send('auth:login-started', 'claude-cli');

  try {
    const success = await new Promise<boolean>((resolve) => {
      // Spawn claude login with stdio: inherit so the browser opens
      const loginProc = spawn('claude', ['login'], {
        stdio: 'inherit', // This allows the CLI to open the browser
        timeout: 120000, // 2 minute timeout
      });

      loginProc.on('close', (code) => {
        resolve(code === 0);
      });

      loginProc.on('error', () => {
        resolve(false);
      });
    });

    if (success) {
      // Verify auth worked
      const status = await checkClaudeAuth();
      const authenticated = status.type === 'ok';
      
      // Notify renderer
      mainWindow?.webContents.send('auth:login-completed', 'claude-cli', authenticated);
      
      return authenticated;
    }

    mainWindow?.webContents.send('auth:login-completed', 'claude-cli', false);
    return false;
  } catch (error) {
    mainWindow?.webContents.send('auth:login-completed', 'claude-cli', false);
    return false;
  }
}

/**
 * Ensure Claude CLI is authenticated, triggering login if needed.
 * Returns true if authenticated (or becomes authenticated).
 */
export async function ensureClaudeAuth(): Promise<boolean> {
  const status = await checkClaudeAuth();
  
  if (status.type === 'ok') {
    return true;
  }

  if (status.type === 'auth') {
    // Auto-trigger login
    return await triggerClaudeLogin();
  }

  // not-installed or other error - can't auto-fix
  return false;
}
