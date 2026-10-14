/**
 * Shared types between Electron main process and React renderer.
 */

export type RunStatus = 
  | 'PENDING' 
  | 'RUNNING' 
  | 'DELIVERED_WITHOUT_PR' 
  | 'DELIVERED_WITH_PR' 
  | 'ESCALATED_TO_HUMAN' 
  | 'FAILED' 
  | 'SUSPENDED';

export type AgentRole = 
  | 'pm-architect' 
  | 'developer' 
  | 'qa-tester' 
  | 'triage' 
  | 'reviewer' 
  | 'security' 
  | 'documentation';

export interface Repository {
  id: string;
  name: string;
  path: string;
  lastAccessed?: string;
}

export interface RunStep {
  step: string;
  attempt: number;
  status: string;
  durationMs: number;
  artifact?: string;
}

export interface FactoryRun {
  runId: string;
  repoId: string;
  task: string;
  status: RunStatus;
  attempts: number;
  branch?: string;
  startedAt: string;
  finishedAt?: string;
  tokens?: {
    total: number;
    input: number;
    output: number;
  };
  gates?: {
    qa?: string;
    codeReview?: string;
    security?: string;
    documentation?: string;
  };
  steps?: RunStep[];
  error?: string;
}

export interface RunArtifact {
  step: string;
  attempt: number;
  status: string;
  model?: string;
  durationMs?: number;
  writtenAt?: string;
  data: any;
}

/** The three human-in-the-loop gates the workflow can pause on. */
export type PendingInputReason =
  | 'CLARIFICATION_REQUIRED'
  | 'DELIVERY_APPROVAL_REQUIRED'
  | 'ESCALATION_REQUIRED';

/**
 * An open input request from a suspended run, mirrored from the workflow's suspend payload
 * to `pending-input.json` so the renderer can render the matching form.
 */
export interface PendingInput {
  reason: PendingInputReason;
  runId: string;
  step: string;

  // CLARIFICATION_REQUIRED
  questions?: string[];
  planSummary?: string;

  // DELIVERY_APPROVAL_REQUIRED
  branch?: string;
  baseBranch?: string;
  commitSha?: string | null;
  commitMessage?: string;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  filesChanged?: number;

  // ESCALATION_REQUIRED
  escalationReason?: string;
  question?: string;
  attempt?: number;
  maxAttempts?: number;
  rootCause?: string;
}

export interface AgentEvent {
  type: 'agent_call' | 'tool_use' | 'step_completed' | 'suite_executed' | 'build_executed' | 'gate_result';
  runId: string;
  timestamp: string;
  role?: AgentRole;
  model?: string;
  data: any;
}

export interface AuthProvider {
  id: 'claude-cli' | 'anthropic-api' | 'google-ai' | 'openai';
  name: string;
  status: 'authenticated' | 'expired' | 'not-configured';
  details?: string;
}

export interface GlobalSettings {
  theme: 'dark' | 'light' | 'system';
  workspaceRoot: string;
  defaultMaxAttempts: number;
  dryRunByDefault: boolean; // Run in dry-run mode (no API calls, no git writes)

  logLevel: 'debug' | 'info' | 'warn' | 'error';
  activeProvider: 'claude-cli' | 'api';
  savedRepositories?: Array<{ name: string; path: string }>; // Manually added repos
}

export interface RepoSettings {
  repoId: string;
  testCommand?: string;
  buildCommand?: string;
  maxAttempts?: number;
  models?: Partial<Record<AgentRole, string>>;
}

export interface Settings {
  global: GlobalSettings;
  repos: Record<string, RepoSettings>;
}
