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
 * Trigger Claude login flow - simplified approach.
 * 
 * Instead of trying to automate the complex CLI flow, we just start polling
 * for auth status. The UI will show instructions to the user to run
 * `claude login` manually in their terminal.
 */
export async function triggerClaudeLogin(): Promise<boolean> {
  console.log('[Claude Auth] Starting login flow - polling for auth status...');
  mainWindow?.webContents.send('auth:login-started', 'claude-cli');

  // Just start polling - the UI will show instructions to the user
  const success = await pollForAuth(60); // Poll for up to 60 seconds initially
  
  mainWindow?.webContents.send('auth:login-completed', 'claude-cli', success);
  return success;
}

/**
 * Poll for authentication status for a given number of seconds.
 */
async function pollForAuth(maxSeconds: number): Promise<boolean> {
  const maxAttempts = Math.floor(maxSeconds / 2);
  
  for (let i = 0; i < maxAttempts; i++) {
    const status = await checkClaudeAuth();
    
    if (status.type === 'ok') {
      console.log('[Claude Auth] ✓ Authentication detected!');
      return true;
    }
    
    if (i % 5 === 0) {
      console.log(`[Claude Auth] Waiting for login... (${i * 2}s)`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('[Claude Auth] Polling timeout');
  return false;
}

/**
 * Manually check auth status - can be called from UI "Check Status" button
 */
export async function refreshAuthStatus(): Promise<boolean> {
  const status = await checkClaudeAuth();
  const isAuthenticated = status.type === 'ok';
  
  console.log('[Claude Auth] Manual status check:', status.type, isAuthenticated ? '✓' : '✗');
  
  return isAuthenticated;
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
