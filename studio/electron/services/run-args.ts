/**
 * The factory CLI arguments for the runs the Studio starts. Pure, so what each setting turns into on the
 * command line can be tested without starting anything.
 */
import type { GlobalSettings } from '../../shared/types';

export interface PipelineSelection {
  qa?: boolean;
  review?: boolean;
  security?: boolean;
  documentation?: boolean;
  polish?: boolean;
}

/** Where a task works: what the form asked for, else the user's default, else a checkout of its own. */
export function effectiveIsolation(
  requested: 'worktree' | 'in-place' | undefined,
  global: Pick<GlobalSettings, 'isolation'>,
): 'worktree' | 'in-place' {
  return requested ?? global.isolation ?? 'worktree';
}

/** `--no-qa` and friends: only the stages the user switched off. */
export function pipelineArgs(pipeline: PipelineSelection | undefined): string[] {
  if (!pipeline) return [];
  const args: string[] = [];
  if (pipeline.qa === false) args.push('--no-qa');
  if (pipeline.review === false) args.push('--no-review');
  if (pipeline.security === false) args.push('--no-security');
  if (pipeline.documentation === false) args.push('--no-docs');
  if (pipeline.polish === false) args.push('--no-polish');
  return args;
}

export interface TaskArgsInput {
  repo: string;
  task: string;
  maxAttempts?: number | undefined;
  dryRun?: boolean | undefined;
  pipeline?: PipelineSelection | undefined;
  isolation: 'worktree' | 'in-place';
  phasing?: 'auto' | 'on' | 'off' | undefined;
}

export function runTaskArgs(input: TaskArgsInput): string[] {
  return [
    'run',
    '--repo', input.repo,
    // `--task=<text>`: a task that starts with "--" must not be taken for a flag.
    `--task=${input.task}`,
    '--isolation', input.isolation,
    ...(input.phasing ? ['--phasing', input.phasing] : []),
    ...(input.maxAttempts ? ['--max-attempts', String(input.maxAttempts)] : []),
    ...(input.dryRun ? ['--dry-run'] : []),
    ...pipelineArgs(input.pipeline),
  ];
}

export interface PhaseArgsInput {
  repoPath: string;
  phaseId: string;
  notes?: string | undefined;
  maxAttempts?: number | undefined;
  dryRun?: boolean | undefined;
  pipeline?: PipelineSelection | undefined;
  isolation: 'worktree' | 'in-place';
}

export function runPhaseArgs(input: PhaseArgsInput): string[] {
  return [
    'run',
    '--phase', input.phaseId,
    '--repo', input.repoPath,
    ...(input.notes?.trim() ? [`--task=${input.notes.trim()}`] : []),
    '--isolation', input.isolation,
    ...(input.maxAttempts ? ['--max-attempts', String(input.maxAttempts)] : []),
    ...(input.dryRun ? ['--dry-run'] : []),
    ...pipelineArgs(input.pipeline),
  ];
}
