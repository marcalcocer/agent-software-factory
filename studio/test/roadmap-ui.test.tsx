// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RUN } from '../../fixtures';
import App from '../src/App';
import { RoadmapPanel } from '../src/components/RoadmapPanel';
import type { Project, ProjectPhase } from '../shared/types';
import { appHandlers, installFakeApi, listOf, REPO_PATH } from './support/fake-api';

const phase = (over: Partial<ProjectPhase> & Pick<ProjectPhase, 'id' | 'ordinal' | 'title'>): ProjectPhase => ({
  goal: '', scope: [], acceptance: [], status: 'PLANNED', dependsOn: [], taskId: null, rootRunId: null, branch: null, prNumber: null, prUrl: null,
  summary: null, notes: [], ready: false, blockedReason: null, ...over,
});

const project = (over: Partial<Project> = {}): Project => ({
  id: 'i0001', title: 'Redesign the frontend', goal: 'Make the whole UI dark, with a design system', kind: 'project', status: 'ACTIVE', nextPhaseId: 'i0001-p2', backlog: [],
  phases: [
    phase({ id: 'i0001-p1', ordinal: 1, title: 'Foundation', status: 'MERGED', summary: 'Tokens and primitives, and privacy masking on the investment page.' }),
    phase({ id: 'i0001-p2', ordinal: 2, title: 'Screens', goal: 'Migrate every screen', status: 'PLANNED', ready: true }),
    phase({ id: 'i0001-p3', ordinal: 3, title: 'Charts', status: 'PLANNED', dependsOn: ['i0001-p2'], blockedReason: 'It builds on phase 2 ("Screens"), which is not merged yet: it would be planned against code that is about to change.' }),
  ],
  ...over,
});

function panel(projects: Project[], over: Partial<React.ComponentProps<typeof RoadmapPanel>> = {}) {
  const props = {
    projects, error: null, onReload: vi.fn(), onProjectChanged: vi.fn(), onStartPhase: vi.fn(async () => {}), ...over,
  };
  render(<RoadmapPanel {...props} />);
  return props;
}

describe('the projects of a repository', () => {
  it('shows nothing for a repository whose tasks are single pull requests', () => {
    installFakeApi({});
    const { container } = render(<RoadmapPanel projects={[]} error={null} onReload={() => {}} onProjectChanged={() => {}} onStartPhase={async () => {}} />);

    expect(container.querySelector('[data-testid="roadmap-panel"]')).toBeNull();
  });

  it('shows where a project stands: how far it is, each phase and what it is doing', () => {
    installFakeApi({});
    panel([project()]);

    expect(screen.getByTestId('project-i0001-progress').textContent).toBe('1 of 3 delivered');
    expect(within(screen.getByTestId('phase-1')).getByText('Delivered')).toBeTruthy();
    expect(within(screen.getByTestId('phase-2')).getByText('Planned')).toBeTruthy();
    expect(screen.getByTestId('phase-1-summary').textContent).toBe('Tokens and primitives, and privacy masking on the investment page.');
  });

  it('lets the user start the phase that can start - and says why another cannot', () => {
    installFakeApi({});
    panel([project()]);

    expect(within(screen.getByTestId('phase-2')).getByRole('button', { name: 'Start phase 2' })).toBeTruthy();
    expect(within(screen.getByTestId('phase-3')).queryByRole('button', { name: /Start phase/ })).toBeNull();
    expect(screen.getByTestId('phase-3-blocked').textContent).toContain('which is not merged yet');
  });

  it('starts the phase', async () => {
    installFakeApi({});
    const user = userEvent.setup();
    const props = panel([project()]);

    await user.click(screen.getByRole('button', { name: 'Start phase 2' }));

    expect(props.onStartPhase).toHaveBeenCalledWith(expect.objectContaining({ id: 'i0001' }), expect.objectContaining({ id: 'i0001-p2' }));
  });

  it('says why a phase could not start - the factory\'s own reason', async () => {
    installFakeApi({});
    const user = userEvent.setup();
    panel([project()], {
      onStartPhase: async () => {
        throw new Error("Error invoking remote method 'project:run-phase': Error: Another run (R9) is still going in this repository and uses the same working copy.");
      },
    });

    await user.click(screen.getByRole('button', { name: 'Start phase 2' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Another run (R9) is still going in this repository and uses the same working copy.');
    expect(screen.getByRole('button', { name: 'Start phase 2' })).toBeTruthy();
  });

  it('shows a phase that is in review with its pull request, and a finished project as finished', () => {
    installFakeApi({});
    panel([
      project({ phases: [phase({ id: 'p1', ordinal: 1, title: 'A', status: 'IN_REVIEW', prNumber: 8, prUrl: 'https://github.com/o/r/pull/8' })], nextPhaseId: null }),
      project({ id: 'i0002', title: 'Done project', status: 'DONE', phases: [phase({ id: 'q1', ordinal: 1, title: 'B', status: 'MERGED', summary: 's' })] }),
    ]);

    expect(screen.getByRole('link', { name: 'pull request #8' }).getAttribute('href')).toBe('https://github.com/o/r/pull/8');
    expect(screen.getByTestId('project-i0002-progress').textContent).toBe('Finished');
  });

  it('shows what the user asked for in a review, and what the roadmap learned, under the phase they belong to', () => {
    installFakeApi({});
    panel([
      project({
        phases: [
          phase({ id: 'p2', ordinal: 2, title: 'Screens', ready: true, notes: [
            { at: '2026-10-20T10:00:00Z', source: 'user-request', text: 'Make the settings page dark too - from the review of pull request #8' },
            { at: '2026-10-20T11:00:00Z', source: 'reconciler', text: 'Round 2 already did the home screen.' },
          ] }),
        ],
      }),
    ]);

    const row = screen.getByTestId('phase-2');
    expect(row.textContent).toContain('Asked for in review of an earlier phase:');
    expect(row.textContent).toContain('Make the settings page dark too');
    expect(row.textContent).toContain('Round 2 already did the home screen.');
  });
});

describe('changing the plan', () => {
  it('skips a phase and takes it back', async () => {
    const edits: unknown[] = [];
    const skipped = project({ phases: project().phases.map((p) => (p.id === 'i0001-p2' ? { ...p, status: 'SKIPPED' as const, ready: false } : p)) });
    installFakeApi({ 'project:edit': (_id: string, edit: unknown) => (edits.push(edit), skipped) });
    const user = userEvent.setup();
    const props = panel([project()]);

    await user.click(within(screen.getByTestId('phase-2')).getByRole('button', { name: 'Skip' }));

    expect(edits).toEqual([{ phases: [{ id: 'i0001-p2', status: 'SKIPPED' }] }]);
    await waitFor(() => expect(props.onProjectChanged).toHaveBeenCalledWith(skipped));
  });

  it('shows a skipped phase struck out, with a way back', async () => {
    const edits: unknown[] = [];
    installFakeApi({ 'project:edit': (_id: string, edit: unknown) => (edits.push(edit), project()) });
    const user = userEvent.setup();
    panel([project({ phases: [phase({ id: 'p2', ordinal: 2, title: 'Screens', status: 'SKIPPED' })] })]);

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    expect(edits).toEqual([{ phases: [{ id: 'p2', status: 'PLANNED' }] }]);
  });

  it('adds a phase at the end', async () => {
    const edits: unknown[] = [];
    installFakeApi({ 'project:edit': (_id: string, edit: unknown) => (edits.push(edit), project()) });
    const user = userEvent.setup();
    panel([project()]);

    await user.click(screen.getByRole('button', { name: 'Add a phase' }));
    expect((screen.getByRole('button', { name: 'Add phase' }) as HTMLButtonElement).disabled).toBe(true); // nothing typed
    await user.type(screen.getByLabelText('Title of the new phase'), '  Dark charts ');
    await user.click(screen.getByRole('button', { name: 'Add phase' }));

    expect(edits).toEqual([{ addPhases: [{ title: 'Dark charts' }] }]);
    expect(screen.queryByLabelText('Title of the new phase')).toBeNull(); // the form closed
  });

  it('says why an edit was refused - history cannot be rewritten', async () => {
    installFakeApi({
      'project:edit': () => {
        throw new Error('Error invoking remote method \'project:edit\': Error: Phase 1 ("Foundation") is merged: it cannot be made skipped by hand.');
      },
    });
    const user = userEvent.setup();
    panel([project()]);

    await user.click(within(screen.getByTestId('phase-2')).getByRole('button', { name: 'Skip' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Phase 1 ("Foundation") is merged: it cannot be made skipped by hand.');
  });

  it('sets a backlog item aside', async () => {
    const edits: unknown[] = [];
    installFakeApi({ 'project:edit': (_id: string, edit: unknown) => (edits.push(edit), project()) });
    const user = userEvent.setup();
    panel([project({ backlog: [{ id: 'b0001', text: 'The chart legend overflows on mobile', severity: 'MINOR', source: 'review', phaseId: null, suggestedPhaseId: null }] })]);

    const backlog = screen.getByTestId('project-i0001-backlog');
    expect(backlog.textContent).toContain('Backlog: 1 thing seen on the way, not asked for');
    await user.click(within(backlog).getByText(/Backlog/)); // open it
    await user.click(within(backlog).getByRole('button', { name: 'Dismiss' }));

    expect(edits).toEqual([{ backlog: [{ id: 'b0001', status: 'DISMISSED' }] }]);
  });
});

describe('comparing a delivered phase with the roadmap', () => {
  const uncompared = project({ phases: [phase({ id: 'p1', ordinal: 1, title: 'Foundation', status: 'MERGED', summary: null }), phase({ id: 'p2', ordinal: 2, title: 'Screens', ready: true })] });

  it('is offered for a phase that was not compared - it is switched off, or the model could not answer', async () => {
    const asked: unknown[][] = [];
    installFakeApi({ 'project:reconcile': (...args: unknown[]) => (asked.push(args), { summary: 'Delivered.', changes: [], backlogAdded: 0, source: 'agent' }) });
    const user = userEvent.setup();
    const props = panel([uncompared]);

    expect(screen.getByText('Not compared with the rest of the roadmap yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Compare with the roadmap' }));

    expect(asked).toEqual([['p1', { force: true }]]);
    await waitFor(() => expect(props.onReload).toHaveBeenCalled());
  });

  it('says why when it could not be done, and offers it again', async () => {
    installFakeApi({
      'project:reconcile': () => {
        throw new Error("Error invoking remote method 'project:reconcile': Error: OAuth session expired. Run `claude login`.");
      },
    });
    const user = userEvent.setup();
    panel([uncompared]);

    await user.click(screen.getByRole('button', { name: 'Compare with the roadmap' }));

    expect((await screen.findByRole('alert')).textContent).toBe('OAuth session expired. Run `claude login`.');
    expect(screen.getByRole('button', { name: 'Compare with the roadmap' })).toBeTruthy();
  });

  it('is not offered once it was done', () => {
    installFakeApi({});
    panel([project()]);

    expect(screen.queryByRole('button', { name: 'Compare with the roadmap' })).toBeNull();
  });
});

describe('on the repository screen', () => {
  const open = async (api: ReturnType<typeof installFakeApi>) => {
    const user = userEvent.setup();
    render(<App />);
    await user.click((await screen.findAllByRole('button', { name: /invest-track/ }))[0]!);
    await waitFor(() => expect(api.callsTo('project:list').length).toBeGreaterThan(0));
    return user;
  };

  it('asks the factory for the projects of the repository on screen, and shows them', async () => {
    const api = installFakeApi(appHandlers({ 'factory:list': () => [], 'project:list': () => [project()] }));
    await open(api);

    expect(await screen.findByTestId('project-i0001')).toBeTruthy();
    expect(api.callsTo('project:list')[0]).toEqual([REPO_PATH]);
  });

  it('shows nothing, and the rest still works, when the factory cannot say', async () => {
    const api = installFakeApi(
      appHandlers({
        'factory:list': () => [],
        'project:list': () => {
          throw new Error('Target repository not found');
        },
      }),
    );
    await open(api);

    expect(await screen.findByText(/Could not read the projects: Target repository not found/)).toBeTruthy();
    expect(screen.getByPlaceholderText(/Describe your next task|e\.g\., Add dark mode/)).toBeTruthy();
  });

  it('starts a phase, opens its run, and shows it in the history under its phase', async () => {
    let started = false;
    const api = installFakeApi(
      appHandlers({
        'factory:list': () => (started ? listOf([RUN.round1]).map((run) => ({ ...run, title: 'Screens', phaseId: 'i0001-p2', initiativeId: 'i0001' })) : []),
        'project:list': () => [project()],
        'project:run-phase': () => ((started = true), { runId: RUN.round1 }),
        'factory:get': () => null,
        'factory:get-artifacts': () => [],
        'factory:get-events': () => [],
        'factory:get-pending-input': () => null,
        'factory:get-output': () => ({ lines: [], total: 0 }),
        'factory:get-rounds': () => [],
        'worktree:info': () => null,
      }),
    );
    const user = await open(api);

    await user.click(await screen.findByRole('button', { name: 'Start phase 2' }));

    await waitFor(() => expect(api.callsTo('project:run-phase')).toEqual([[{ repoPath: REPO_PATH, phaseId: 'i0001-p2' }]]));
    // The run is on screen, like a task the user typed.
    expect(await screen.findByTestId('run-breadcrumb')).toBeTruthy();
  });

  it('labels a run of a phase in the history: which phase of which project', async () => {
    const api = installFakeApi(
      appHandlers({
        'factory:list': () => listOf([RUN.round1]).map((run) => ({ ...run, title: 'Foundation', phaseId: 'i0001-p1', initiativeId: 'i0001' })),
        'project:list': () => [project()],
      }),
    );
    await open(api);

    expect((await screen.findByTestId('phase-badge')).textContent).toBe('Phase 1 of 3 · Redesign the frontend');
  });

  it('does not label a run that is not a phase of a project', async () => {
    const api = installFakeApi(appHandlers({ 'factory:list': () => listOf([RUN.round1]), 'project:list': () => [project()] }));
    await open(api);

    await screen.findByText(/I want to do a big refactor/);
    expect(screen.queryByTestId('phase-badge')).toBeNull();
  });

  it('looks at the projects again when the factory says the roadmap moved - a phase was merged, a comparison finished', async () => {
    let list = [project()];
    const api = installFakeApi(appHandlers({ 'factory:list': () => [], 'project:list': () => list }));
    await open(api);
    await screen.findByText('1 of 3 delivered');

    list = [project({ phases: project().phases.map((p) => (p.id === 'i0001-p2' ? { ...p, status: 'MERGED' as const, summary: 'Done.', ready: false } : p)), nextPhaseId: 'i0001-p3' })];
    api.emit('project:changed', REPO_PATH);

    expect(await screen.findByText('2 of 3 delivered')).toBeTruthy();
  });

  it('starts a phase in the checkout it chooses - the default - without the user\'s repository being involved', async () => {
    const api = installFakeApi(
      appHandlers({
        'factory:list': () => [],
        'project:list': () => [project()],
        'project:run-phase': () => new Promise(() => {}),
      }),
    );
    const user = await open(api);

    await user.click(await screen.findByRole('button', { name: 'Start phase 2' }));

    // No isolation is named: the main process takes the default from Settings.
    await waitFor(() => expect(api.callsTo('project:run-phase')[0]![0]).not.toHaveProperty('isolation'));
  });
});
