/**
 * The commands about projects (initiatives) and their phases.
 *
 * The factory CLI is the only writer of the initiative store; the Studio asks for everything through
 * these commands, each of which prints ONE marker line on stdout (`INITIATIVE_LIST_JSON {...}`) so that
 * stray log lines cannot break the parse - the same convention as `PR_CHECK_JSON`.
 *
 * Kept apart from `factory.ts` (which runs `main()` on import) so the commands can be tested.
 */
import { asBoolean, asString, errorMessageOf, printMarker, type FlagValue } from './flags.ts';
import { applyInitiativeEdit, EditRefused, parseInitiativeEdit } from '../initiatives/edit.ts';
import { reconcilePhase } from '../initiatives/reconcile.ts';
import { withStore } from '../initiatives/store.ts';
import { initiativeView } from '../initiatives/view.ts';
import { resolveRepoPath } from '../utils/factory-config.ts';

type Flags = Record<string, FlagValue>;

const usage = (message: string): number => {
  process.stderr.write(`${message}\n`);
  return 2;
};

/**
 * Lists the projects of a repository with their phases, which phase can start, and the open backlog.
 * A project nobody planned (a quick task, a single phase) is left out unless `--include-quick`.
 */
export async function commandInitiativeList(flags: Flags): Promise<number> {
  const repo = asString(flags.repo);
  if (!repo) return usage('--repo is required.');
  try {
    const repoPath = resolveRepoPath(repo, { requireGit: false });
    const initiatives = await withStore(async (store) => {
      const list = await store.listInitiatives(repoPath, {
        includeQuick: asBoolean(flags['include-quick']) ?? false,
        includeArchived: asBoolean(flags['include-archived']) ?? false,
      });
      return await Promise.all(list.map(async (initiative) => initiativeView(initiative, await store.listBacklog(initiative.id))));
    });
    printMarker('INITIATIVE_LIST_JSON', { repoPath, initiatives });
    return 0;
  } catch (error) {
    printMarker('INITIATIVE_LIST_JSON', { error: errorMessageOf(error) });
    return 1;
  }
}

/**
 * Changes a roadmap: `--initiative <id> --patch '<json>'` (see `initiativeEditSchema`). Prints the
 * project as it is afterwards, or the reason nothing was changed.
 */
export async function commandInitiativeEdit(flags: Flags): Promise<number> {
  const id = asString(flags.initiative);
  const patch = asString(flags.patch);
  if (!id || !patch) return usage("--initiative <id> and --patch '<json>' are required.");
  try {
    const edit = parseInitiativeEdit(patch);
    const initiative = await withStore(async (store) => {
      const changed = await applyInitiativeEdit(store, id, edit);
      return initiativeView(changed, await store.listBacklog(id));
    });
    printMarker('INITIATIVE_EDIT_JSON', { initiative });
    return 0;
  } catch (error) {
    printMarker('INITIATIVE_EDIT_JSON', { error: error instanceof EditRefused ? error.message : errorMessageOf(error) });
    return 1;
  }
}

/**
 * Compares a merged phase with the rest of the roadmap (see `reconcilePhase`). `report` is null when
 * there was nothing to do: the phase is not merged, or it was reconciled already (`--force` asks again).
 */
export async function commandPhaseReconcile(flags: Flags): Promise<number> {
  const phaseId = asString(flags.phase);
  if (!phaseId) return usage('--phase <phaseId> is required.');
  try {
    const report = await reconcilePhase({ phaseId, force: asBoolean(flags.force) ?? false });
    printMarker('PHASE_RECONCILE_JSON', { report });
    return 0;
  } catch (error) {
    printMarker('PHASE_RECONCILE_JSON', { error: errorMessageOf(error) });
    return 1;
  }
}
