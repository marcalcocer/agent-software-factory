/**
 * What every command of the CLI shares: reading flag values, and the one-line machine-readable result
 * the Studio looks for on stdout.
 *
 * Kept apart from `factory.ts` (which runs `main()` on import) so the commands in other modules - and
 * their tests - can use it.
 */
import type { FlagValue } from './pipeline-flags.ts';

export type { FlagValue };

export function asString(value: FlagValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function asBoolean(value: FlagValue | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function asInteger(value: FlagValue | undefined): number | undefined {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Prints a machine-readable result line the Studio looks for (stray log lines cannot break it). */
export function printMarker(marker: string, payload: unknown): void {
  process.stdout.write(`${marker} ${JSON.stringify(payload)}\n`);
}

/** Normalises whatever Mastra reports as a failure (Error, string, serialised object). */
export function errorMessageOf(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string' && message.trim() !== '') return message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
