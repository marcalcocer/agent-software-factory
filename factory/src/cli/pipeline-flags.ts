/**
 * Per-task stage selection from CLI flags.
 *
 * Kept apart from `factory.ts` (which executes `main()` on import) so the parsing can be
 * exercised on its own.
 *
 * Why this exists: the Studio sends `--no-qa`, `--no-review`, `--no-security` and `--no-docs`
 * for the stages the user deselected, but the CLI never read them. The workflow already
 * supports skipping stages (`run.pipeline`), so every run silently executed the full pipeline
 * and spent tokens on stages the user had switched off.
 */

export type FlagValue = string | boolean;

export type StageName = 'qa' | 'review' | 'security' | 'documentation';

/** Optional stages and every flag name that addresses them (`--no-docs` -> documentation). */
const STAGE_FLAG_NAMES: Record<StageName, readonly string[]> = {
  qa: ['qa'],
  review: ['review'],
  security: ['security'],
  documentation: ['docs', 'documentation'],
};

function isFalse(value: FlagValue): boolean {
  if (typeof value === 'boolean') return value === false;
  return ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

/**
 * Builds the stage selection from parsed CLI flags.
 *
 * Only stages that were explicitly switched off are returned - the workflow merges the result
 * over `DEFAULT_PIPELINE` - and `undefined` means "run everything".
 *
 * `parseArgs` turns a trailing `--no-qa` into `flags.qa === false`, but a `--no-qa` followed by
 * a bare word is stored as `flags['no-qa'] = <word>` instead, so both spellings are honoured,
 * as is the explicit `--qa=false` / `--docs false` form.
 */
export function parsePipelineFlags(
  flags: Record<string, FlagValue>,
): Partial<Record<StageName, boolean>> | undefined {
  const pipeline: Partial<Record<StageName, boolean>> = {};

  for (const stage of Object.keys(STAGE_FLAG_NAMES) as StageName[]) {
    const disabled = STAGE_FLAG_NAMES[stage].some((name) => {
      const direct = flags[name];
      if (direct !== undefined && isFalse(direct)) return true;

      // `--no-<name>` that swallowed a following bare word: still a request to disable.
      const negated = flags[`no-${name}`];
      return negated !== undefined && !isFalse(negated);
    });
    if (disabled) pipeline[stage] = false;
  }

  return Object.keys(pipeline).length > 0 ? pipeline : undefined;
}
