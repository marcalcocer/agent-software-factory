import { describe, expect, it } from 'vitest';

import { RUN, readEvents, runDir } from '../../fixtures';
import { readRunArtifacts } from '../electron/services/run-state';
import { derivePipeline, type DerivedPipeline } from '../shared/pipelineState';
import type { PendingInput, PipelineConfig, RunArtifact } from '../shared/types';

const ALL_STAGES: PipelineConfig = { qa: true, review: true, security: true, documentation: true };

/** What the pipeline strip would be given for a real run, read the way the Studio reads it. */
function derive(
  runId: string,
  overrides: {
    artifacts?: (all: RunArtifact[]) => RunArtifact[];
    eventCount?: number;
    runStatus?: string;
    pendingInput?: PendingInput | null;
    failedStep?: string;
  } = {},
): DerivedPipeline {
  const all = readRunArtifacts(runDir(runId));
  const events = readEvents(runId).slice(0, overrides.eventCount) as never[];
  return derivePipeline({
    artifacts: overrides.artifacts ? overrides.artifacts(all) : all,
    events,
    pendingInput: overrides.pendingInput ?? null,
    runStatus: overrides.runStatus ?? 'DELIVERED',
    assumeAlive: false,
    pipeline: ALL_STAGES,
    failedStep: overrides.failedStep ?? null,
  });
}

const statuses = (derived: DerivedPipeline): Record<string, string> =>
  Object.fromEntries(derived.nodes.map((node) => [node.id, node.status]));

describe('derivePipeline on a delivered first round', () => {
  const derived = derive(RUN.round1);

  it('shows every step, in order, with the retry the run really made', () => {
    expect(derived.nodes.map((node) => node.id)).toEqual([
      'prepare-run',
      'pm-architect',
      'clarification-1',
      'pm-architect-plan',
      'developer-1',
      'qa-tester-1',
      'triage-1',
      'developer-2',
      'qa-tester-2',
      'reviewer',
      'security',
      'documentation',
      'pr-writer',
      'delivery',
    ]);
    expect(derived.lifecycle).toBe('done');
    expect(derived.attempt).toBe(2);
    expect(derived.failedNodeId).toBeNull();
  });

  it('marks the failed QA of attempt 1, and everything else as completed', () => {
    const status = statuses(derived);
    expect(status['qa-tester-1']).toBe('failed');
    expect(Object.entries(status).filter(([, value]) => value !== 'completed')).toEqual([['qa-tester-1', 'failed']]);
  });

  it('keeps the question the architect asked and the answer the human gave', () => {
    expect(derived.exchanges).toHaveLength(1);
    const [exchange] = derived.exchanges;
    expect(exchange!.questions).toHaveLength(8);
    expect(exchange!.questions[0]).toContain('shadcn/ui');
    expect(exchange!.answer).toContain('8) per phases');
    expect(exchange!.open).toBe(false);
  });
});

describe('derivePipeline on a further round', () => {
  const derived = derive(RUN.round2);
  const node = (id: string) => derived.nodes.find((entry) => entry.id === id)!;

  it('shows the architect as skipped, because the plan of the previous round was reused', () => {
    expect(node('pm-architect')).toMatchObject({
      status: 'skipped',
      activity: 'Skipped: the plan of the previous round is reused',
    });
    expect(derived.exchanges).toEqual([]);
  });

  it('shows the PR writer as skipped, because the pull request already has its text', () => {
    expect(node('pr-writer')).toMatchObject({
      status: 'skipped',
      activity: 'Skipped: the pull request already has its title and description',
    });
  });

  it('shows the delivery as completed once the pull request was updated', () => {
    expect(node('delivery').status).toBe('completed');
    expect(derived.lifecycle).toBe('done');
  });
});

describe('derivePipeline on a run in progress', () => {
  it('shows QA running as soon as the developer has finished', () => {
    const derived = derive(RUN.round1, {
      artifacts: (all) => all.filter((a) => a.step === 'pm-architect' || (a.step === 'developer' && a.attempt === 1)),
      eventCount: 10,
      runStatus: 'RUNNING',
    });

    expect(derived.lifecycle).toBe('running');
    expect(derived.runningIds).toEqual(['qa-tester-1']);
    const qa = derived.nodes.find((entry) => entry.id === 'qa-tester-1')!;
    expect(qa.status).toBe('running');
    expect(qa.activity).toBe('Running the build and the test suite...');
  });

  it('shows review and security running side by side', () => {
    // Everything up to and including the QA of attempt 2, which passed: the two gates start together.
    const derived = derive(RUN.round1, {
      artifacts: (all) => all.filter((a) => ['pm-architect', 'developer', 'qa-tester', 'triage'].includes(a.step)),
      eventCount: 22,
      runStatus: 'RUNNING',
    });

    expect([...derived.runningIds].sort()).toEqual(['reviewer', 'security']);
  });

  it('shows the architect running again once the questions were answered', () => {
    const derived = derive(RUN.round1, {
      artifacts: () => [
        {
          step: 'pm-architect',
          attempt: 1,
          status: 'CLARIFICATION_REQUIRED',
          data: { plan: { clarificationQuestions: ['Q?'] } },
        },
      ],
      eventCount: 6,
      runStatus: 'RUNNING',
    });

    expect(derived.runningIds).toEqual(['pm-architect-plan']);
  });
});

describe('derivePipeline on a run waiting for a human', () => {
  it('shows the delivery as waiting for approval', () => {
    const derived = derive(RUN.round1, {
      artifacts: (all) => all.filter((a) => a.step !== 'delivery'),
      eventCount: 33,
      runStatus: 'SUSPENDED',
      pendingInput: { reason: 'DELIVERY_APPROVAL_REQUIRED', runId: RUN.round1, step: 'pull-request' },
    });

    expect(derived.lifecycle).toBe('waiting');
    const delivery = derived.nodes.find((entry) => entry.id === 'delivery')!;
    expect(delivery.status).toBe('waiting');
    expect(delivery.activity).toBe('Waiting for your approval to push and open a pull request');
    expect(derived.runningIds).toEqual([]);
  });

  it('shows the open question while the architect waits for answers', () => {
    const derived = derive(RUN.round1, {
      artifacts: () => [
        { step: 'pm-architect', attempt: 1, status: 'CLARIFICATION_REQUIRED', data: { plan: { clarificationQuestions: [] } } },
      ],
      eventCount: 5,
      runStatus: 'SUSPENDED',
      pendingInput: { reason: 'CLARIFICATION_REQUIRED', runId: RUN.round1, step: 'plan', questions: ['Q1?'] },
    });

    expect(derived.lifecycle).toBe('waiting');
    expect(derived.nodes.find((entry) => entry.id === 'clarification-1')!.status).toBe('waiting');
    expect(derived.exchanges[0]).toMatchObject({ open: true });
  });
});

describe('derivePipeline on a failed run', () => {
  it('blames the step that had not reported when the run stopped', () => {
    const derived = derive(RUN.round1, {
      artifacts: (all) => all.filter((a) => a.step === 'pm-architect'),
      eventCount: 8,
      runStatus: 'FAILED',
    });

    expect(derived.lifecycle).toBe('failed');
    expect(derived.failedNodeId).toBe('developer-1');
    expect(derived.nodes.find((entry) => entry.id === 'developer-1')!.status).toBe('failed');
  });

});

describe('derivePipeline and the stages a task switched off', () => {
  const switchedOff: PipelineConfig = { qa: true, review: false, security: false, documentation: false };
  const nodesOf = (derived: DerivedPipeline) => Object.fromEntries(derived.nodes.map((entry) => [entry.id, entry]));

  it('shows a stage that never ran as skipped, with the reason, and never as pending', () => {
    const derived = derivePipeline({
      artifacts: readRunArtifacts(runDir(RUN.round1)).filter((a) => !['code-review', 'security', 'documentation'].includes(a.step)),
      events: readEvents(RUN.round1) as never[],
      pendingInput: null,
      runStatus: 'DELIVERED',
      assumeAlive: false,
      pipeline: switchedOff,
    });
    const nodes = nodesOf(derived);

    for (const id of ['reviewer', 'security', 'documentation']) {
      expect(nodes[id]).toMatchObject({ status: 'skipped', activity: 'Disabled for this task', disabled: true });
    }
    expect(nodes['qa-tester-2']!.disabled).toBeFalsy();
  });

  it('shows what a stage really did when it ran although the form says it was off', () => {
    // Runs from before the CLI honoured the toggles recorded real output for these stages.
    const derived = derivePipeline({
      artifacts: readRunArtifacts(runDir(RUN.smokeHappy)),
      events: readEvents(RUN.smokeHappy) as never[],
      pendingInput: null,
      runStatus: 'DELIVERED_WITHOUT_PR',
      assumeAlive: false,
      pipeline: switchedOff,
    });

    expect(nodesOf(derived)['reviewer']!.status).toBe('completed');
  });
});

describe('derivePipeline and the step that names the task', () => {
  const named = (events: Array<Record<string, unknown>>, artifacts: RunArtifact[], runStatus = 'RUNNING') =>
    derivePipeline({
      artifacts,
      events: events.map((e) => ({ at: 't', ...e })) as never[],
      pendingInput: null,
      runStatus,
      assumeAlive: false,
      pipeline: ALL_STAGES,
    });

  const namer = (status: string, data: Record<string, unknown> = { title: 'Dark mode', slug: 'dark-mode', type: 'feat' }): RunArtifact => ({
    step: 'run-namer',
    attempt: 1,
    status,
    data,
  });

  it('shows the Name step between Prepare and the architect, running while the AI is asked', () => {
    const derived = named([{ type: 'run_started' }, { type: 'run_naming', phase: 'started' }], []);

    expect(derived.nodes.map((node) => node.id).slice(0, 3)).toEqual(['prepare-run', 'run-namer', 'pm-architect']);
    expect(derived.runningIds).toEqual(['run-namer']);
    const nodes = Object.fromEntries(derived.nodes.map((node) => [node.id, node]));
    expect(nodes['prepare-run']!.status).toBe('completed'); // the repository is ready: the name is the last thing before the branch
    expect(nodes['run-namer']).toMatchObject({ status: 'running', activity: 'Naming the task...' });
  });

  it('moves on to the architect once the task has a name', () => {
    const derived = named([{ type: 'run_naming', phase: 'started' }], [namer('COMPLETED')]);
    expect(derived.runningIds).toEqual(['pm-architect']);
    expect(derived.nodes.find((node) => node.id === 'run-namer')!.status).toBe('completed');
  });

  it('counts a name made from the request as a step that worked, and says how it was made', () => {
    const derived = named([{ type: 'run_naming' }], [namer('FALLBACK', { title: 'Dark mode', slug: 'dark-mode', type: 'feat', error: 'usage limit' })], 'DELIVERED');
    expect(derived.nodes.find((node) => node.id === 'run-namer')).toMatchObject({
      status: 'completed',
      activity: 'Named from the request: the AI could not answer',
    });
  });

  it('is absent on runs from before tasks were named', () => {
    expect(derive(RUN.round1).nodes.some((node) => node.id === 'run-namer')).toBe(false);
    expect(derive(RUN.round2).nodes.some((node) => node.id === 'run-namer')).toBe(false);
  });
});
