/**
 * IPC channel definitions for type-safe communication between main and renderer.
 */

import type { AgentEvent, AuthProvider, FactoryRun, Repository, RunArtifact, Settings } from './types';

export interface IPCChannels {
  // Repository management
  'repo:list': () => Promise<Repository[]>;
  'repo:add': (path: string) => Promise<Repository>;
  'repo:browse': () => Promise<Repository | null>;
  'repo:remove': (id: string) => Promise<void>;
  'repo:select': (path: string) => Promise<void>;

  // Factory operations
  'factory:run': (params: {
    repoPath: string;
    task: string;
    criteria?: string[];
    maxAttempts?: number;
    branch?: string;
  }) => Promise<{ runId: string }>;
  'factory:run-task': (params: {
    repo: string;
    task: string;
    maxAttempts?: number;
    dryRun?: boolean;
  }) => Promise<{ runId: string }>;
  'factory:resume': (params: {
    runId: string;
    decision?: 'ACKNOWLEDGE' | 'ABORT';
    guidance?: string;
    clarifications?: string;
  }) => Promise<void>;
  'factory:list': (repoPath?: string) => Promise<FactoryRun[]>;
  'factory:list-repos': () => Promise<Array<{ name: string; path: string; recentRuns: number }>>;
  'factory:get': (runId: string) => Promise<FactoryRun | null>;
  'factory:get-artifacts': (runId: string) => Promise<RunArtifact[]>;
  'factory:cancel': (runId: string) => Promise<void>;

  // Real-time events
  'factory:subscribe': (runId: string) => Promise<void>;
  'factory:unsubscribe': (runId: string) => Promise<void>;

  // Authentication
  'auth:status': () => Promise<AuthProvider[]>;
  'auth:login': (provider: 'claude-cli') => Promise<boolean>;
  'auth:refresh': () => Promise<boolean>;
  'auth:setApiKey': (provider: 'anthropic-api' | 'google-ai', key: string) => Promise<boolean>;

  // Settings
  'settings:get': () => Promise<Settings>;
  'settings:update': (settings: Partial<Settings>) => Promise<void>;
  'settings:getRepo': (repoId: string) => Promise<Settings['repos'][string] | null>;
  'settings:updateRepo': (repoId: string, settings: Partial<Settings['repos'][string]>) => Promise<void>;

  // Diff viewer
  'diff:get': (repoPath: string, runId?: string) => Promise<{ files: string[]; diff: string }>;

  // Logs
  'logs:get': (runId: string) => Promise<{ path: string; content: string }[]>;
  'logs:tail': (runId: string, file: string) => Promise<string>;
}

// Events that flow from main to renderer
export interface IPCEvents {
  'agent:event': (event: AgentEvent) => void;
  'run:status': (runId: string, status: FactoryRun['status']) => void;
  'auth:changed': (providers: AuthProvider[]) => void;
  'factory:output': (runId: string, data: string) => void;
  'factory:completed': (runId: string, exitCode: number) => void;
  'factory:error': (runId: string, error: string) => void;
  'auth:login-started': (provider: string) => void;
  'auth:login-completed': (provider: string, success: boolean) => void;
}
