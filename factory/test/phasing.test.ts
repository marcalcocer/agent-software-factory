import { describe, expect, it } from 'vitest';

import { RUN, readJson } from '../../fixtures';
import {
  MAX_PHASES,
  phaseTask,
  readiness,
  renderInitiativeContext,
  roadmapFromPlan,
  roadmapView,
} from '../src/initiatives/phasing.ts';
import type { BacklogRow, InitiativeWithPhases, PhaseRow } from '../src/initiatives/store.ts';
import { executionPlanSchema, type Phasing } from '../src/utils/schemas.ts';

const phase = (over: Partial<Phasing['phases'][number]> = {}): Phasing['phases'][number] => ({
  title: 'A phase',
  goal: 'Something is true',
  scope: ['one'],
  acceptance: ['it works'],
  dependsOn: [],
  ...over,
});
const plan = (phasing: Phasing | null | undefined) => ({ summary: 's', phasing });
const proposal = (phases: Phasing['phases'], over: Partial<Phasing> = {}): Phasing => ({
  phased: true,
  reason: 'Too big',
  initiativeTitle: 'Redo the frontend',
  phases,
  ...over,
});

describe('roadmapFromPlan', () => {
  it('is none for a plan that does not propose phases: the normal case', () => {
    expect(roadmapFromPlan(plan(null), 'T')).toBeNull();
    expect(roadmapFromPlan(plan(undefined), 'T')).toBeNull();
    expect(roadmapFromPlan(plan(proposal([phase(), phase()], { phased: false })), 'T')).toBeNull();
  });

  it('is none for a "roadmap" of fewer than two phases, or without titles', () => {
    expect(roadmapFromPlan(plan(proposal([phase()])), 'T')).toBeNull();
    expect(roadmapFromPlan(plan(proposal([phase(), phase({ title: '   ' })])), 'T')).toBeNull();
  });

  it('cleans the words of each phase, and names the initiative', () => {
    const roadmap = roadmapFromPlan(
      plan(proposal([
        phase({ title: '  "design tokens and dark mode."  ', scope: ['  tokens ', 'tokens', 'theme\ntoggle', ''], goal: 'The   foundation.' }),
        phase({ title: 'Detail screens' }),
      ])),
      'fallback',
    )!;

    expect(roadmap.title).toBe('Redo the frontend');
    expect(roadmap.phases[0]).toMatchObject({ title: 'Design tokens and dark mode', goal: 'The foundation.', scope: ['tokens', 'theme toggle'] });
  });

  it('makes each phase wait for the one before it unless it names something else', () => {
    const roadmap = roadmapFromPlan(
      plan(proposal([phase({ title: 'One' }), phase({ title: 'Two' }), phase({ title: 'Three', dependsOn: [1] }), phase({ title: 'Four', dependsOn: [3, 9, 4, 0] })])),
      'T',
    )!;

    expect(roadmap.phases.map((p) => p.dependsOnOrdinals)).toEqual([[], [1], [1], [3]]); // 9, 4 (itself) and 0 do not exist before it
  });

  it('keeps no more than eight phases', () => {
    const many = Array.from({ length: 12 }, (_, i) => phase({ title: `Phase ${i + 1}` }));
    expect(roadmapFromPlan(plan(proposal(many)), 'T')!.phases).toHaveLength(MAX_PHASES);
  });

  it('falls back to the task\'s own title when the architect named no initiative', () => {
    expect(roadmapFromPlan(plan(proposal([phase(), phase({ title: 'B' })], { initiativeTitle: '' })), 'Big redesign')!.title).toBe('Big redesign');
  });

  it('accepts the plans written before phasing existed: they have no such field', () => {
    const oldPlan = readJson(RUN.round1, '01-pm-architect.json').data.plan;
    const parsed = executionPlanSchema.parse(oldPlan);

    expect(parsed.phasing).toBeUndefined();
    expect(roadmapFromPlan(parsed, 'T')).toBeNull();
  });

  it('turns the "Phase 2+" prose of the real UI-refactor plan into something that could have been proposed', () => {
    // The architect wrote this in prose: "Phase 2+: investment detail page, Details list, form modals" under outOfScope.
    const real = readJson(RUN.round1, '01-pm-architect.json').data.plan;
    const roadmap = roadmapFromPlan(
      plan(proposal([
        phase({ title: 'Design tokens, dark mode and app shell', scope: real.tasks.map((t: { title: string }) => t.title) }),
        phase({ title: 'Investment page, Details list and modals', scope: ['Investment.jsx', 'InvestmentStats', 'form modals'] }),
        phase({ title: 'About and 404 pages, accessibility pass' }),
      ])),
      'T',
    )!;

    expect(roadmap.phases).toHaveLength(3);
    expect(roadmap.phases[0]!.scope).toContain('Design tokens and Tailwind theme');
  });
});

/* ---------------------------------------------------------------------------------------------- */

const at = '2026-10-19T17:00:00Z';
const row = (ordinal: number, status: PhaseRow['status'], over: Partial<PhaseRow> = {}): PhaseRow => ({
  id: `i0007-p${ordinal}`, initiativeId: 'i0007', ordinal, title: `Title ${ordinal}`, goal: `Goal ${ordinal}`, scope: [`scope ${ordinal}`], acceptance: [`accept ${ordinal}`],
  dependsOn: ordinal > 1 ? [`i0007-p${ordinal - 1}`] : [], status, taskId: null, rootRunId: null, branch: null, prNumber: null, prUrl: null,
  mergedSha: null, mergedAt: null, summary: null, notes: [], createdAt: at, updatedAt: at, ...over,
});
const initiative = (phases: PhaseRow[], over: Partial<InitiativeWithPhases> = {}): InitiativeWithPhases => ({
  id: 'i0007', repoPath: '/w/repo', repoName: 'repo', kind: 'project', title: 'Redo the frontend', goal: 'I want a big refactor of the UI',
  status: 'ACTIVE', decisions: [], constraints: [], createdAt: at, updatedAt: at, phases, backlogOpen: 0, ...over,
});

describe('renderInitiativeContext: what the architect reads when it plans one phase', () => {
  const doc = initiative(
    [
      row(1, 'MERGED', { summary: 'Tokens, theme toggle, header.' }),
      row(2, 'PLANNED', {
        notes: [{ at, source: 'reconciler', text: 'Dark mode of the investment page was already done in round 2 of phase 1.' }, { at, source: 'user-request', text: 'Investment Details is white in dark mode' }],
      }),
      row(3, 'PLANNED'),
    ],
    { decisions: [{ questions: ['One PR per phase?'], answer: '8) per phases', at }], constraints: ['Keep the dashboards as they are'] },
  );
  const backlog: BacklogRow[] = [
    { id: 'b0001', initiativeId: 'i0007', phaseId: 'i0007-p1', source: 'security', text: 'XSS in ChartUtils tooltip', severity: 'INFO', evidence: '', suggestedPhaseId: null, status: 'OPEN', createdAt: at },
    { id: 'b0002', initiativeId: 'i0007', phaseId: null, source: 'review', text: 'dismissed one', severity: 'MINOR', evidence: '', suggestedPhaseId: null, status: 'DISMISSED', createdAt: at },
  ];
  const text = renderInitiativeContext(doc, 'i0007-p2', backlog);

  it('has the goal and what the user decided, marked as authoritative', () => {
    expect(text).toContain('Goal, as the user gave it: I want a big refactor of the UI');
    expect(text).toContain('What the user decided (authoritative):');
    expect(text).toContain('Answered: 8) per phases');
    expect(text).toContain('Keep the dashboards as they are');
  });

  it('shows every phase with where it stands, and points at the one being planned', () => {
    expect(text).toContain('1. Title 1 [delivered]');
    expect(text).toContain('Delivered: Tokens, theme toggle, header.');
    expect(text).toContain('2. Title 2 [planned] <- THE PHASE YOU ARE PLANNING');
    expect(text).toContain('3. Title 3 [planned]');
  });

  it('gives the phase\'s own words, what is out of scope, and what changed since the roadmap', () => {
    expect(text).toContain('Your phase - 2. Title 2');
    expect(text).toContain('Out of scope - these are later phases:');
    expect(text).toContain('Phase 3: Title 3');
    expect(text).toContain('[reconciler] Dark mode of the investment page was already done in round 2 of phase 1.');
  });

  it('lists only the open backlog', () => {
    expect(text).toContain('[security/INFO] XSS in ChartUtils tooltip');
    expect(text).not.toContain('dismissed one');
  });

  it('is short enough to put in front of every agent', () => {
    expect(text.length).toBeLessThan(3_500);
  });
});

describe('phaseTask: a phase as a request', () => {
  it('reads like a task, in the phase\'s own words, with what the user asked for while reviewing', () => {
    const task = phaseTask(
      initiative([row(1, 'MERGED'), row(2, 'PLANNED', { notes: [{ at, source: 'user-request', text: 'Investment Details is white in dark mode' }, { at, source: 'reconciler', text: 'Header is done already.' }] })]),
      row(2, 'PLANNED', { notes: [{ at, source: 'user-request', text: 'Investment Details is white in dark mode' }, { at, source: 'reconciler', text: 'Header is done already.' }] }),
    );

    expect(task.split('\n')[0]).toBe('Phase 2 of 2 of "Redo the frontend": Title 2');
    expect(task).toContain('Goal: Goal 2');
    expect(task).toContain('Scope:\n- scope 2');
    expect(task).toContain('Acceptance:\n- accept 2');
    expect(task).toContain('The user asked for these while reviewing an earlier phase, and agreed they belong here:\n- Investment Details is white in dark mode');
    expect(task).toContain('Since this phase was planned:\n- Header is done already.');
  });

  it('does not count a skipped phase in the total', () => {
    expect(phaseTask(initiative([row(1, 'MERGED'), row(2, 'SKIPPED'), row(3, 'PLANNED')]), row(3, 'PLANNED')).split('\n')[0]).toContain('Phase 3 of 2 of');
  });
});

describe('roadmapView: what the pull request shows', () => {
  it('has the phases and the one this pull request is', () => {
    const view = roadmapView(initiative([row(1, 'IN_REVIEW'), row(2, 'PLANNED'), row(3, 'PLANNED')]), 'i0007-p1')!;
    expect(view).toMatchObject({ title: 'Redo the frontend', current: 1, total: 3 });
    expect(view.phases.map((p) => [p.ordinal, p.status])).toEqual([[1, 'IN_REVIEW'], [2, 'PLANNED'], [3, 'PLANNED']]);
  });

  it('is none for a task with one phase, for no initiative, and for a phase that is not in it', () => {
    expect(roadmapView(initiative([row(1, 'RUNNING')]), 'i0007-p1')).toBeNull();
    expect(roadmapView(null, 'x')).toBeNull();
    expect(roadmapView(initiative([row(1, 'RUNNING'), row(2, 'PLANNED')]), 'nope')).toBeNull();
  });

  it('leaves out a skipped phase, unless it is the one the pull request is', () => {
    const view = roadmapView(initiative([row(1, 'MERGED'), row(2, 'SKIPPED'), row(3, 'RUNNING')]), 'i0007-p3')!;
    expect(view.phases.map((p) => p.ordinal)).toEqual([1, 3]);
    expect(view.total).toBe(2);
  });
});

describe('readiness: can this phase start', () => {
  const phases = [row(1, 'IN_REVIEW'), row(2, 'PLANNED'), row(3, 'PLANNED')];

  it('is not while what it builds on is not merged, and says which phase', () => {
    const verdict = readiness(initiative(phases), phases[1]!);
    expect(verdict.ready).toBe(false);
    expect(!verdict.ready && verdict.reason).toContain('phase 1 ("Title 1"), which is not merged yet');
  });

  it('is once the phases it depends on are merged or skipped', () => {
    expect(readiness(initiative([row(1, 'MERGED'), row(2, 'PLANNED')]), row(2, 'PLANNED'))).toEqual({ ready: true });
    expect(readiness(initiative([row(1, 'SKIPPED'), row(2, 'PLANNED')]), row(2, 'PLANNED'))).toEqual({ ready: true });
  });

  it('is not for a phase that has already started', () => {
    const verdict = readiness(initiative([row(1, 'MERGED'), row(2, 'RUNNING')]), row(2, 'RUNNING'));
    expect(!verdict.ready && verdict.reason).toContain('is in progress');
  });
});
