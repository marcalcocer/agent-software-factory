import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyInitiativeEdit, EditRefused, parseInitiativeEdit, type InitiativeEdit } from '../src/initiatives/edit.ts';
import { withStore } from '../src/initiatives/store.ts';
import { initiativeView } from '../src/initiatives/view.ts';

const REPO = '/home/dev/workspace/invest-track';
let logs: string;

beforeEach(() => {
  logs = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-edit-'));
  vi.stubEnv('FACTORY_LOG_DIR', logs);
});
afterEach(() => fs.rmSync(logs, { recursive: true, force: true }));

/** Phase 1 merged; phases 2-4 waiting; two loose ends in the backlog. */
async function project(repoPath = REPO) {
  return await withStore(async (store) => {
    const created = await store.createInitiative({ repoPath, title: 'Redesign', goal: 'Redesign the frontend', firstPhase: { title: 'Foundation' } });
    const set = await store.setRoadmap(created.id, {
      title: 'Redesign the frontend',
      phases: [{ title: 'Foundation', scope: ['tokens'] }, { title: 'Privacy mode', goal: 'Hide amounts', scope: ['mask amounts'], acceptance: ['none readable'] }, { title: 'Screens' }, { title: 'Cleanup' }],
    });
    await store.markMerged(set.phases[0]!.id);
    await store.addBacklog(set.id, [
      { source: 'review', text: 'The chart legend overflows on mobile' },
      { source: 'qa', text: 'Header toggle has no keyboard shortcut' },
    ]);
    return set;
  });
}

const edit = (patch: InitiativeEdit, id = 'i0001') => withStore((store) => applyInitiativeEdit(store, id, patch));
const phase = (initiative: Awaited<ReturnType<typeof edit>>, ordinal: number) => initiative.phases.find((candidate) => candidate.ordinal === ordinal)!;
const current = async (id = 'i0001') => (await withStore((store) => store.getInitiative(id)))!;

describe('parseInitiativeEdit', () => {
  it('reads an edit', () => {
    expect(parseInitiativeEdit('{"title":"  New name  ","phases":[{"id":"i0001-p2","status":"SKIPPED"}]}')).toEqual({ title: 'New name', phases: [{ id: 'i0001-p2', status: 'SKIPPED' }] });
  });

  it.each([
    ['not JSON', '{ nope', 'not valid JSON'],
    ['a field it does not know - a typo would otherwise do nothing', '{"titel":"x"}', 'edit'],
    ['an empty title', '{"title":"  "}', 'title'],
    ['a status the user may not set', '{"status":"DONE"}', 'status'],
    ['a phase status the user may not set', '{"phases":[{"id":"i0001-p2","status":"MERGED"}]}', 'phases.0.status'],
    ['more phases at once than a roadmap holds', `{"addPhases":[${Array.from({ length: 9 }, () => '{"title":"x"}').join(',')}]}`, 'addPhases'],
  ])('refuses %s', (_name, raw, mention) => {
    expect(() => parseInitiativeEdit(raw)).toThrow(EditRefused);
    expect(() => parseInitiativeEdit(raw)).toThrow(mention);
  });
});

describe('applyInitiativeEdit', () => {
  it('renames the project and rewrites its goal', async () => {
    await project();
    const after = await edit({ title: 'Frontend redesign', goal: 'Make it dark' });

    expect(after).toMatchObject({ title: 'Frontend redesign', goal: 'Make it dark' });
  });

  it('rewords a phase that is waiting', async () => {
    await project();
    const after = await edit({ phases: [{ id: 'i0001-p2', title: 'Privacy', goal: 'Hide every amount', scope: ['mask amounts', 'a toggle'], acceptance: ['nothing readable'] }] });

    expect(phase(after, 2)).toMatchObject({ title: 'Privacy', goal: 'Hide every amount', scope: ['mask amounts', 'a toggle'], acceptance: ['nothing readable'], status: 'PLANNED' });
    expect(phase(after, 3).title).toBe('Screens');
  });

  it('skips a phase and takes it back, and a skipped phase no longer holds up the next', async () => {
    await project();
    const skipped = await edit({ phases: [{ id: 'i0001-p2', status: 'SKIPPED' }] });
    expect(phase(skipped, 2).status).toBe('SKIPPED');
    expect(initiativeView(skipped, []).nextPhaseId).toBe('i0001-p3');

    const back = await edit({ phases: [{ id: 'i0001-p2', status: 'PLANNED' }] });
    expect(phase(back, 2).status).toBe('PLANNED');
    expect(initiativeView(back, []).nextPhaseId).toBe('i0001-p2');
  });

  it('appends phases at the end, each waiting for the one before it', async () => {
    await project();
    const after = await edit({ addPhases: [{ title: 'Dark charts', scope: ['recolour the charts'] }, { title: 'Docs' }] });

    expect(after.phases.map((candidate) => [candidate.ordinal, candidate.title, candidate.status])).toEqual([
      [1, 'Foundation', 'MERGED'], [2, 'Privacy mode', 'PLANNED'], [3, 'Screens', 'PLANNED'], [4, 'Cleanup', 'PLANNED'], [5, 'Dark charts', 'PLANNED'], [6, 'Docs', 'PLANNED'],
    ]);
    expect(phase(after, 5).dependsOn).toEqual(['i0001-p4']);
    expect(phase(after, 6).dependsOn).toEqual(['i0001-p5']);
    expect(phase(after, 5).scope).toEqual(['recolour the charts']);
  });

  it('keeps a loose end out of sight when it is set aside, and gives a promoted one to a phase', async () => {
    await project();
    const after = await edit({ backlog: [{ id: 'b0001', status: 'DISMISSED' }, { id: 'b0002', status: 'PROMOTED', phaseId: 'i0001-p3' }] });

    const items = await withStore((store) => store.listBacklog('i0001'));
    expect(items.map((item) => [item.id, item.status])).toEqual([['b0001', 'DISMISSED'], ['b0002', 'PROMOTED']]);
    expect(phase(after, 3).notes.at(-1)).toMatchObject({ source: 'user', text: 'From the backlog: Header toggle has no keyboard shortcut' });
    expect(initiativeView(after, items).backlog).toEqual([]);
  });

  it('closes the project when nothing is left to do, and reopens it when something is', async () => {
    await project();
    const done = await edit({ phases: ['i0001-p2', 'i0001-p3', 'i0001-p4'].map((id) => ({ id, status: 'SKIPPED' as const })) });
    expect(done.status).toBe('DONE');

    const reopened = await edit({ phases: [{ id: 'i0001-p3', status: 'PLANNED' }] });
    expect(reopened.status).toBe('ACTIVE');
  });

  it('archives a project and takes it back - and archived stays archived whatever its phases do', async () => {
    await project();
    expect((await edit({ status: 'ARCHIVED' })).status).toBe('ARCHIVED');
    // Everything left is skipped: an active project would be DONE now. An archived one is not.
    expect((await edit({ phases: ['i0001-p2', 'i0001-p3', 'i0001-p4'].map((id) => ({ id, status: 'SKIPPED' as const })) })).status).toBe('ARCHIVED');
    // Taken back, it is what its phases say.
    expect((await edit({ status: 'ACTIVE' })).status).toBe('DONE');
  });

  it('records that the user edited it', async () => {
    await project();
    await edit({ title: 'Renamed' });

    const events = await withStore((store) => store.listEvents('i0001'));
    expect(events.at(-1)).toMatchObject({ type: 'edited_by_user', data: { fields: ['title'] } });
  });
});

describe('applyInitiativeEdit refuses what would rewrite history', () => {
  it.each([
    ['skipping a phase that is merged', { phases: [{ id: 'i0001-p1', status: 'SKIPPED' as const }] }, 'Phase 1 ("Foundation") is merged: it cannot be made skipped by hand.'],
    ['rewording a phase that is merged', { phases: [{ id: 'i0001-p1', scope: ['other'] }] }, 'is merged: only its title can be changed now.'],
    ['a phase that is not in this project', { phases: [{ id: 'i0009-p1', title: 'x' }] }, 'i0009-p1 is not a phase of "Redesign the frontend"'],
    ['a backlog item that is not in this project', { backlog: [{ id: 'b0099', status: 'DISMISSED' as const }] }, 'b0099 is not in the backlog'],
    ['promoting a loose end without saying where', { backlog: [{ id: 'b0001', status: 'PROMOTED' as const }] }, 'say which phase of this roadmap it goes to'],
    ['promoting a loose end into a merged phase', { backlog: [{ id: 'b0001', status: 'PROMOTED' as const, phaseId: 'i0001-p1' }] }, 'cannot go to Phase 1 ("Foundation"), which is merged'],
    ['an edit that changes nothing', { phases: [] }, 'There is nothing to change.'],
  ])('%s', async (_name, patch, message) => {
    await project();
    await expect(edit(patch as InitiativeEdit)).rejects.toThrow(message);
  });

  it('lets the title of a merged phase be corrected', async () => {
    await project();
    const after = await edit({ phases: [{ id: 'i0001-p1', title: 'Design foundation' }] });

    expect(phase(after, 1)).toMatchObject({ title: 'Design foundation', status: 'MERGED' });
  });

  it('refuses to reword a phase that is in review, but lets its title change', async () => {
    await project();
    await withStore((store) => store.updatePhase('i0001-p2', { status: 'IN_REVIEW' }));

    await expect(edit({ phases: [{ id: 'i0001-p2', goal: 'other' }] })).rejects.toThrow('Phase 2 ("Privacy mode") is in review: only its title can be changed now.');
    await expect(edit({ phases: [{ id: 'i0001-p2', status: 'SKIPPED' }] })).rejects.toThrow('is in review: it cannot be made skipped by hand.');
    expect(phase(await edit({ phases: [{ id: 'i0001-p2', title: 'Privacy, in review' }] }), 2).title).toBe('Privacy, in review');
  });

  it('refuses a phase of another project', async () => {
    await project();
    await project('/home/dev/workspace/other');

    await expect(edit({ phases: [{ id: 'i0002-p2', title: 'x' }] }, 'i0001')).rejects.toThrow('i0002-p2 is not a phase of "Redesign the frontend"');
  });

  it('refuses to add phases to an archived project', async () => {
    await project();
    await edit({ status: 'ARCHIVED' });

    await expect(edit({ addPhases: [{ title: 'More' }] })).rejects.toThrow('archived');
  });

  it('says so when the project does not exist', async () => {
    await expect(edit({ title: 'x' }, 'i0042')).rejects.toThrow('There is no project i0042.');
  });

  it('changes nothing at all when one part of the edit is refused', async () => {
    await project();
    const before = await current();

    await expect(
      edit({ title: 'Renamed', addPhases: [{ title: 'New' }], phases: [{ id: 'i0001-p2', title: 'Changed' }, { id: 'i0001-p1', status: 'SKIPPED' }] }),
    ).rejects.toThrow(EditRefused);

    const after = await current();
    expect(after.title).toBe(before.title);
    expect(after.phases.map((candidate) => candidate.title)).toEqual(before.phases.map((candidate) => candidate.title));
  });
});

describe('initiativeView', () => {
  it('says which phase can start and why another cannot', async () => {
    await project();
    const view = initiativeView(await current(), await withStore((store) => store.listBacklog('i0001')));

    expect(view.nextPhaseId).toBe('i0001-p2');
    expect(view.phases.map((candidate) => [candidate.ordinal, candidate.ready])).toEqual([[1, false], [2, true], [3, false], [4, false]]);
    expect(view.phases[2]!.blockedReason).toContain('phase 2 ("Privacy mode"), which is not merged yet');
    // Only a phase that is waiting has something to wait for.
    expect(view.phases.map((candidate) => candidate.blockedReason === null)).toEqual([true, true, false, false]);
    expect(view.backlog).toHaveLength(2);
  });
});
