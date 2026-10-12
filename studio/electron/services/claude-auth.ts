/**
 * Claude CLI authentication service - handles auto-login flow.
 */
import { spawn, spawnSync } from 'node:child_process';
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
 * Detect the available terminal emulator on the system
 */
function detectTerminal(): string | null {
  const terminals = [
    'gnome-terminal',
    'konsole',
    'xfce4-terminal',
    'mate-terminal',
    'tilix',
    'terminator',
    'xterm',
    'x-terminal-emulator',
  ];

  for (const term of terminals) {
    try {
      const result = spawnSync('which', [term], { encoding: 'utf8' });
      if (result.status === 0 && result.stdout.trim()) {
        return term;
      }
    } catch {
      // Continue to next terminal
    }
  }
  return null;
}

/**
 * Trigger Claude login flow - opens a terminal window for the user to complete login.
 * 
 * The Claude Code CLI requires interactive input. We open a real terminal window
 * so the user can see the CLI, type /login, and complete the authentication.
 */
export async function triggerClaudeLogin(): Promise<boolean> {
  console.log('[Claude Auth] Starting Claude Code login...');
  mainWindow?.webContents.send('auth:login-started', 'claude-cli');

  try {
    const terminal = detectTerminal();
    
    if (!terminal) {
      console.error('[Claude Auth] No terminal emulator found');
      mainWindow?.webContents.send('auth:login-completed', 'claude-cli', false);
      return false;
    }

    console.log('[Claude Auth] Using terminal:', terminal);

    // Build the command to run in the terminal
    // We create a script that runs claude login, then waits for user to close
    const loginCommand = 'claude login; echo ""; echo "Login complete! You can close this window."; read -p "Press Enter to close..."';

    const success = await new Promise<boolean>((resolve) => {
      let terminalProc: ReturnType<typeof spawn>;

      // Different terminals have different syntax for running commands
      if (terminal === 'gnome-terminal') {
        terminalProc = spawn(terminal, ['--', 'bash', '-c', loginCommand], {
          detached: true,
        });
      } else if (terminal === 'konsole') {
        terminalProc = spawn(terminal, ['-e', 'bash', '-c', loginCommand], {
          detached: true,
        });
      } else if (terminal === 'xterm') {
        terminalProc = spawn(terminal, ['-e', 'bash', '-c', loginCommand], {
          detached: true,
        });
      } else {
        // Generic fallback - most terminals support -e
        terminalProc = spawn(terminal, ['-e', 'bash', '-c', loginCommand], {
          detached: true,
        });
      }

      // Don't wait for the terminal to close - poll for auth instead
      terminalProc.unref();

      // Poll for authentication status
      let attempts = 0;
      const maxAttempts = 150; // 5 minutes (2 second intervals)
      
      const pollInterval = setInterval(async () => {
        attempts++;
        
        const status = await checkClaudeAuth();
        
        if (status.type === 'ok') {
          clearInterval(pollInterval);
          console.log('[Claude Auth] ✓ Authentication successful!');
          resolve(true);
          return;
        }
        
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          console.log('[Claude Auth] Timeout waiting for authentication');
          resolve(false);
          return;
        }
        
        if (attempts % 15 === 0) {
          console.log(`[Claude Auth] Waiting for login... (${Math.floor(attempts * 2 / 60)}m ${(attempts * 2) % 60}s)`);
        }
      }, 2000);

      terminalProc.on('error', (error) => {
        clearInterval(pollInterval);
        console.error('[Claude Auth] Terminal error:', error);
        resolve(false);
      });
    });

    mainWindow?.webContents.send('auth:login-completed', 'claude-cli', success);
    return success;
    
  } catch (error) {
    console.error('[Claude Auth] Login flow error:', error);
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
