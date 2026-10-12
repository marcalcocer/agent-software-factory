/**
 * IPC handlers for authentication.
 */
import { ipcMain } from 'electron';
import { checkClaudeAuth, triggerClaudeLogin } from '../services/claude-auth.js';
import type { AuthProvider } from '../../shared/types';

// Get status of all auth providers
ipcMain.handle('auth:status', async (): Promise<AuthProvider[]> => {
  const providers: AuthProvider[] = [];

  // Check Claude CLI
  const claudeStatus = await checkClaudeAuth();
  providers.push({
    id: 'claude-cli',
    name: 'Claude CLI (Subscription)',
    status: claudeStatus.type === 'ok' ? 'authenticated' : 
            claudeStatus.type === 'auth' ? 'expired' : 'not-configured',
    details: claudeStatus.message,
  });

  // Check Anthropic API key (from env or stored config)
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  providers.push({
    id: 'anthropic-api',
    name: 'Anthropic API',
    status: anthropicKey ? 'authenticated' : 'not-configured',
  });

  // Check Google AI key
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  providers.push({
    id: 'google-ai',
    name: 'Google AI',
    status: googleKey ? 'authenticated' : 'not-configured',
  });

  return providers;
});

// Trigger Claude login
ipcMain.handle('auth:login', async (provider: 'claude-cli'): Promise<boolean> => {
  if (provider === 'claude-cli') {
    return await triggerClaudeLogin();
  }
  return false;
});

// Set API key for a provider
ipcMain.handle('auth:setApiKey', async (
  _event,
  provider: 'anthropic-api' | 'google-ai',
  key: string
): Promise<boolean> => {
  // For now, we'll store in process.env
  // TODO: Persist to secure storage (electron-store or keytar)
  if (provider === 'anthropic-api') {
    process.env.ANTHROPIC_API_KEY = key;
    return true;
  }
  if (provider === 'google-ai') {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
    return true;
  }
  return false;
});
