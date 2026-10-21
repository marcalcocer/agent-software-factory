/**
 * The projects of a repository: a big request the architect split into phases, each its own pull request.
 *
 * Shows where each project stands and what can start now; the user owns the plan, so a phase can be
 * skipped (and taken back), phases can be added, and what the review left in the backlog can be set
 * aside. A phase that was delivered is compared with the roadmap once (the factory does it when the
 * pull request is merged); if that was not done - it is switched off, or the model could not answer - it
 * can be asked for here.
 *
 * Everything goes through the factory (`project:*`): the Studio never opens the project database.
 */
import { useState } from 'react';

import type { PhaseStatus, Project, ProjectEdit, ProjectPhase } from '@shared/types';

const messageOf = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const PHASE_CHIP: Record<PhaseStatus, { label: string; chip: string }> = {
  PLANNED: { label: 'Planned', chip: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200' },
  RUNNING: { label: 'Running', chip: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200' },
  IN_REVIEW: { label: 'In review', chip: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' },
  MERGED: { label: 'Delivered', chip: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200' },
  SKIPPED: { label: 'Skipped', chip: 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400 line-through' },
};

const small =
  'px-2.5 py-1 rounded-md text-xs font-medium border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed';
const primary = 'px-2.5 py-1 rounded-md text-xs font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed';

interface PhaseRowProps {
  project: Project;
  phase: ProjectPhase;
  busy: string | null;
  onStart: (phase: ProjectPhase) => void;
  onEdit: (label: string, edit: ProjectEdit) => void;
  onCompare: (phase: ProjectPhase) => void;
  comparing: boolean;
}

/**
 * What the factory said about a phase that is still true: why it is waiting again (its run delivered without a
 * pull request, was aborted, or its pull request was closed), or why it was not compared with the roadmap. Only
 * the latest note, and only while the phase is in the state it explains - once it runs again, or is compared,
 * the note is history.
 */
export function factoryNoteOf(phase: ProjectPhase): string | null {
  const latest = phase.notes.filter((note) => note.source === 'factory').at(-1);
  if (!latest) return null;
  const explains = phase.status === 'PLANNED' || (phase.status === 'MERGED' && !phase.summary);
  return explains ? latest.text : null;
}

function PhaseRow({ phase, busy, onStart, onEdit, onCompare, comparing }: PhaseRowProps) {
  const chip = PHASE_CHIP[phase.status];
  const requests = phase.notes.filter((note) => note.source === 'user-request');
  const changes = phase.notes.filter((note) => note.source === 'reconciler');
  const factoryNote = factoryNoteOf(phase);

  return (
    <li data-testid={`phase-${phase.ordinal}`} className="space-y-1 rounded border border-slate-200 dark:border-slate-700 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {phase.ordinal}. {phase.title}
        </span>
        <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${chip.chip}`}>{chip.label}</span>
        {phase.status === 'IN_REVIEW' && phase.prUrl && (
          <a href={phase.prUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline">
            pull request #{phase.prNumber}
          </a>
        )}
        <span className="flex-1" />
        {phase.status === 'PLANNED' && phase.ready && (
          <button disabled={busy !== null} onClick={() => onStart(phase)} className={primary}>
            {busy === `start:${phase.id}` ? 'Starting...' : `Start phase ${phase.ordinal}`}
          </button>
        )}
        {phase.status === 'PLANNED' && (
          <button disabled={busy !== null} onClick={() => onEdit(`skip:${phase.id}`, { phases: [{ id: phase.id, status: 'SKIPPED' }] })} className={small}>
            Skip
          </button>
        )}
        {phase.status === 'SKIPPED' && (
          <button disabled={busy !== null} onClick={() => onEdit(`restore:${phase.id}`, { phases: [{ id: phase.id, status: 'PLANNED' }] })} className={small}>
            Restore
          </button>
        )}
      </div>

      {phase.goal && phase.status !== 'MERGED' && <p className="text-xs text-slate-500 dark:text-slate-400">{phase.goal}</p>}
      {factoryNote && (
        <p className="text-xs text-amber-700 dark:text-amber-300" data-testid={`phase-${phase.ordinal}-note`}>
          {factoryNote}
        </p>
      )}
      {phase.status === 'PLANNED' && !phase.ready && phase.blockedReason && (
        <p className="text-xs text-amber-700 dark:text-amber-300" data-testid={`phase-${phase.ordinal}-blocked`}>
          {phase.blockedReason}
        </p>
      )}

      {phase.status === 'MERGED' && (
        <div className="text-xs text-slate-600 dark:text-slate-300">
          {phase.summary ? (
            <p data-testid={`phase-${phase.ordinal}-summary`}>{phase.summary}</p>
          ) : (
            <p className="flex flex-wrap items-center gap-2">
              <span>Not compared with the rest of the roadmap yet.</span>
              <button disabled={busy !== null || comparing} onClick={() => onCompare(phase)} className={small}>
                {comparing ? 'Comparing...' : 'Compare with the roadmap'}
              </button>
            </p>
          )}
        </div>
      )}

      {requests.length > 0 && (
        <div className="text-xs text-slate-600 dark:text-slate-300">
          <p className="font-medium">Asked for in review of an earlier phase:</p>
          <ul className="list-disc list-inside">
            {requests.map((note) => (
              <li key={`${note.at}-${note.text}`}>{note.text}</li>
            ))}
          </ul>
        </div>
      )}
      {changes.length > 0 && (
        <ul className="list-disc list-inside text-xs text-indigo-700 dark:text-indigo-300">
          {changes.map((note) => (
            <li key={`${note.at}-${note.text}`}>{note.text}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

interface ProjectCardProps {
  project: Project;
  busy: string | null;
  comparing: Set<string>;
  onStart: (project: Project, phase: ProjectPhase) => void;
  onEdit: (project: Project, label: string, edit: ProjectEdit) => void;
  onCompare: (phase: ProjectPhase) => void;
}

function ProjectCard({ project, busy, comparing, onStart, onEdit, onCompare }: ProjectCardProps) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const counted = project.phases.filter((phase) => phase.status !== 'SKIPPED');
  const delivered = counted.filter((phase) => phase.status === 'MERGED').length;

  return (
    <div data-testid={`project-${project.id}`} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="font-semibold text-slate-900 dark:text-slate-100">{project.title}</h4>
        <span className="text-xs text-slate-500 dark:text-slate-400" data-testid={`project-${project.id}-progress`}>
          {project.status === 'DONE' ? 'Finished' : `${delivered} of ${counted.length} delivered`}
        </span>
      </div>
      {project.goal && <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2" title={project.goal}>{project.goal}</p>}

      <ol className="space-y-2">
        {project.phases.map((phase) => (
          <PhaseRow
            key={phase.id}
            project={project}
            phase={phase}
            busy={busy}
            comparing={comparing.has(phase.id)}
            onStart={(target) => onStart(project, target)}
            onEdit={(label, edit) => onEdit(project, label, edit)}
            onCompare={onCompare}
          />
        ))}
      </ol>

      {adding ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() === '') return;
            onEdit(project, 'add', { addPhases: [{ title: title.trim() }] });
            setTitle('');
            setAdding(false);
          }}
        >
          <input
            aria-label="Title of the new phase"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What should the new phase do?"
            className="flex-1 min-w-48 px-2 py-1 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
          />
          <button type="submit" disabled={busy !== null || title.trim() === ''} className={small}>
            Add phase
          </button>
          <button type="button" onClick={() => setAdding(false)} className={small}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={small}>
          Add a phase
        </button>
      )}

      {project.backlog.length > 0 && (
        <details data-testid={`project-${project.id}-backlog`} className="text-sm">
          <summary className="cursor-pointer text-slate-700 dark:text-slate-200">
            Backlog: {project.backlog.length} thing{project.backlog.length === 1 ? '' : 's'} seen on the way, not asked for
          </summary>
          <ul className="mt-2 space-y-1">
            {project.backlog.map((item) => (
              <li key={item.id} className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
                <span className="flex-1">
                  <span className="text-slate-400">[{item.source}]</span> {item.text}
                </span>
                <button disabled={busy !== null} onClick={() => onEdit(project, `dismiss:${item.id}`, { backlog: [{ id: item.id, status: 'DISMISSED' }] })} className={small}>
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

interface RoadmapPanelProps {
  /** The projects of the repository on screen, as the factory reported them. */
  projects: Project[];
  /** Why they could not be read, if they could not. */
  error: string | null;
  /** Read them again. */
  onReload: () => void;
  /** A project was changed here: it is replaced by the factory's answer. */
  onProjectChanged: (project: Project) => void;
  /** Starts a run on the phase and opens it. Rejects with the reason when it cannot start. */
  onStartPhase: (project: Project, phase: ProjectPhase) => Promise<void>;
}

export function RoadmapPanel({ projects, error: loadError, onReload, onProjectChanged, onStartPhase }: RoadmapPanelProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [comparing, setComparing] = useState<Set<string>>(new Set());
  const error = actionError ?? loadError;

  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setActionError(null);
    try {
      await work();
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const edit = (project: Project, label: string, change: ProjectEdit) =>
    act(label, async () => {
      onProjectChanged(await window.api.invoke('project:edit', project.id, change));
    });

  const compare = async (phase: ProjectPhase) => {
    setComparing((previous) => new Set(previous).add(phase.id));
    setActionError(null);
    try {
      await window.api.invoke('project:reconcile', phase.id, { force: true });
      onReload();
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setComparing((previous) => {
        const next = new Set(previous);
        next.delete(phase.id);
        return next;
      });
    }
  };

  // Nothing to show: a repository whose tasks are all single pull requests has no project.
  if (projects.length === 0) {
    return error ? (
      <div role="alert" className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
        Could not read the projects: {error}
      </div>
    ) : null;
  }

  return (
    <section aria-label="Projects" data-testid="roadmap-panel" className="bg-white dark:bg-slate-800 rounded-lg shadow-sm p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Projects</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">A big request split into phases. Each phase is its own pull request; the next one starts when the one before it is merged.</p>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            busy={busy}
            comparing={comparing}
            onStart={(target, phase) => void act(`start:${phase.id}`, () => onStartPhase(target, phase))}
            onEdit={(target, label, change) => void edit(target, label, change)}
            onCompare={(phase) => void compare(phase)}
          />
        ))}
      </div>
    </section>
  );
}
