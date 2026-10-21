#!/usr/bin/env -S npx tsx
/**
 * Graph smoke test.
 *
 * Executes the complete factory workflow once per dry-run scenario and asserts the routing,
 * the loop behaviour, the suspend/resume contract and the artifacts written to `logs/<runId>/`.
 * No LLM is called and the target repository is never modified, so this is safe to run in CI
 * and without provider credentials.
 *
 *   npm run smoke
 *   npm run smoke -- --scenario retry
 *
 * The traces and the workflow database go to a throwaway directory, never to the real `logs/`:
 * a smoke run in the real one lands in the Studio's run history and in the database that holds
 * real suspended runs. Set `FACTORY_LOG_DIR` to keep them (CI does, to upload them on failure).
 * A failed run keeps its directory and prints where it is.
 */
import 'dotenv/config';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedLogDir =
  process.env.FACTORY_LOG_DIR === undefined || process.env.FACTORY_LOG_DIR.trim() === ''
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'factory-smoke-'))
    : undefined;
if (isolatedLogDir) {
  process.env.FACTORY_LOG_DIR = isolatedLogDir;
  process.env.FACTORY_STORAGE_URL = `file:${path.join(isolatedLogDir, 'factory.db')}`;
}

process.env.FACTORY_DRY_RUN = 'true';
process.env.FACTORY_ALLOW_PUSH = process.env.FACTORY_ALLOW_PUSH ?? 'false';
process.env.FACTORY_ALLOW_PR = process.env.FACTORY_ALLOW_PR ?? 'false';
process.env.FACTORY_LOG_LEVEL = process.env.FACTORY_LOG_LEVEL ?? 'warn';

const { mastra } = await import('../mastra/index.ts');
const { generateRunId, traceDirFor } = await import('../tools/logger-tools.ts');
const { PROJECT_ROOT } = await import('../utils/factory-config.ts');

interface ScenarioExpectation {
  scenario: string;
  description: string;
  interactive: boolean;
  /** Expected terminal status, or `suspended` when human input must be requested. */
  expect: 'suspended' | string;
  /** Resume payload applied when the run suspends, plus the status expected afterwards. */
  resume?: { data: Record<string, unknown>; expect: string };
  expectedAttempts?: number;
  requiredArtifacts: string[];
  /** Optional stages to switch off for this scenario (what `--no-qa` / `--no-docs` ... do). */
  pipeline?: { qa?: boolean; review?: boolean; security?: boolean; documentation?: boolean; polish?: boolean };
  /** Run as a further round on a pull request, the way `revise` starts one. */
  round?: boolean;
  /** What the user allowed the architect to do about phasing. */
  phasing?: 'auto' | 'on' | 'off';
  /** The dry-run scenario the stubs follow, when it is not `scenario` (the architect proposes phases, the user said no). */
  dryRunScenario?: string;
  /** Further assertions on what the run wrote. Each entry is `[name, ok, detail]`. */
  extraChecks?: (traceDir: string) => Array<[string, boolean, string?]> | Promise<Array<[string, boolean, string?]>>;
  /** More work once the run is checked: another run that builds on this one. */
  then?: (context: { label: string; traceDir: string }) => Promise<void>;
}

/**
 * What must hold for the pull-request text of any run that reaches delivery: it was written by the PR
 * writer (whatever the documentation stage did), the delivery used exactly that text, and the
 * "Quality gates" section is the factory's own - it states the true outcome of every stage.
 */
function prTextChecks(
  traceDir: string,
  expected: { documentation: string; expectGates: string[] },
): Array<[string, boolean, string?]> {
  const read = (file: string): Record<string, any> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(traceDir, file), 'utf8')) as Record<string, any>;
    } catch {
      return null;
    }
  };
  const docs = read('07-documentation.json');
  const writer = read('07-pr-writer.json');
  const delivery = read('08-pull-request.json');
  const body: string = writer?.data?.pullRequest?.body ?? '';
  const title: string = writer?.data?.pullRequest?.title ?? '';
  const checks: Array<[string, boolean, string?]> = [
    ['documentation artifact has the expected status', docs?.status === expected.documentation, `status=${String(docs?.status)}`],
    ['the PR writer ran and completed', writer?.status === 'COMPLETED', `status=${String(writer?.status)}`],
    ['the PR writer produced a title, a description and a commit message', title !== '' && body.length > 40 && String(writer?.data?.commitMessage ?? '') !== '', title],
    ['the title is not the raw task text', title !== '' && !title.startsWith('Smoke test the factory graph'), title],
    ['delivery used the PR writer\'s title', delivery?.data?.pullRequest?.title === title, String(delivery?.data?.pullRequest?.title)],
    ['delivery used the PR writer\'s description', delivery?.data?.pullRequest?.body === body],
    ['the description carries no placeholder about a disabled stage', !/this description was not written/i.test(body)],
  ];
  for (const line of expected.expectGates) {
    checks.push([`the Quality gates section says "${line}"`, body.includes(`- ${line}`)]);
  }
  return checks;
}

/**
 * What `summary.json` reports for the quality gates. A stage that was switched off did not run, so it
 * must read `SKIPPED` - never the passing verdict its placeholder report carries.
 */
function gateChecks(
  traceDir: string,
  expected: { qa: string; codeReview: string; security: string; documentation: string },
): Array<[string, boolean, string?]> {
  let gates: Record<string, unknown> = {};
  try {
    gates = (JSON.parse(fs.readFileSync(path.join(traceDir, 'summary.json'), 'utf8')) as { gates?: Record<string, unknown> }).gates ?? {};
  } catch {
    // reported below
  }
  return (Object.keys(expected) as Array<keyof typeof expected>).map((gate) => [
    `summary.json reports ${gate} as ${expected[gate]}`,
    gates[gate] === expected[gate],
    `reported=${String(gates[gate])}`,
  ]);
}

/**
 * What must hold for the identity of any run: it was named by the run namer before the architect, it
 * has a task id, its branch follows the convention `factory/<id>/<type>-<slug>`, the title and the id
 * reached the run record and the summary, and the record was completed rather than started twice.
 */
function namingChecks(traceDir: string): Array<[string, boolean, string?]> {
  const read = (file: string): Record<string, any> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(traceDir, file), 'utf8')) as Record<string, any>;
    } catch {
      return null;
    }
  };
  const events = (() => {
    try {
      return fs
        .readFileSync(path.join(traceDir, 'events.ndjson'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, any>);
    } catch {
      return [];
    }
  })();
  const namer = read('00-run-namer.json');
  const meta = read('run.json');
  const summary = read('summary.json');
  const firstOf = (type: string) => events.findIndex((event) => event.type === type);
  const branch = String(meta?.branch ?? '');

  return [
    ['the run namer named the task', namer?.status === 'COMPLETED' && Boolean(namer?.data?.title), String(namer?.status)],
    ['the task has an id', /^f\d{4,}$/.test(String(meta?.taskId)), String(meta?.taskId)],
    [
      'the branch follows factory/<id>/<type>-<slug>',
      branch === `factory/${meta?.taskId}/${namer?.data?.type}-${namer?.data?.slug}`,
      branch,
    ],
    ['the title reached the run record', meta?.title === namer?.data?.title && meta?.titleSource === 'agent', `${meta?.title} (${meta?.titleSource})`],
    ['the summary carries the id and the title', summary?.taskId === meta?.taskId && summary?.title === meta?.title, `${summary?.taskId} ${summary?.title}`],
    [
      'the task was named before the architect planned',
      firstOf('run_naming') !== -1 &&
        firstOf('run_naming') < events.findIndex((event) => event.type === 'step_artifact' && event.step === 'pm-architect'),
      `naming@${firstOf('run_naming')}`,
    ],
    ['the run was started once, not twice', events.filter((event) => event.type === 'run_started').length === 1, String(events.filter((event) => event.type === 'run_started').length)],
  ];
}

/**
 * What must hold for the polish pass of any run that reaches delivery: it left an artifact saying what it
 * did, and that artifact agrees with the pull-request text - the quality gates carry its line.
 */
function polishChecks(
  traceDir: string,
  expected: { status: string; applied?: number; reportedNit?: boolean; gateLine: RegExp },
): Array<[string, boolean, string?]> {
  const read = (file: string): Record<string, any> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(traceDir, file), 'utf8')) as Record<string, any>;
    } catch {
      return null;
    }
  };
  const polish = read('06-polish.json');
  const body = String(read('08-pull-request.json')?.data?.pullRequest?.body ?? '');
  const events = (() => {
    try {
      return fs.readFileSync(path.join(traceDir, 'events.ndjson'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
    } catch {
      return [];
    }
  })();
  const asked = events.filter((event) => event.type === 'agent_call' && event.step === 'polish');

  return [
    ['the polish pass recorded what it did', polish?.status === expected.status, String(polish?.status)],
    ...(expected.applied === undefined
      ? ([['the polish pass did not ask the developer when there was nothing to fix', asked.length === 0, String(asked.length)]] as Array<[string, boolean, string?]>)
      : ([
          ['the developer was asked once, as the developer', asked.length === 1 && asked[0]?.role === 'developer', String(asked.length)],
          ['the findings it fixed are named by id', (polish?.data?.applied ?? []).length === expected.applied, JSON.stringify(polish?.data?.applied)],
          ['a nit is reported and not fixed', expected.reportedNit === undefined || (polish?.data?.reported ?? []).some((item: any) => item.reason === 'a nit') === expected.reportedNit, JSON.stringify(polish?.data?.reported)],
        ] as Array<[string, boolean, string?]>)),
    ['the quality gates of the description carry the polish line', expected.gateLine.test(body), (/- Polish:[^\n]*/.exec(body) ?? [''])[0]],
  ];
}

/** What `revise` hands the workflow, in miniature: round 2 of a pull request, with one review comment. */
const SMOKE_REVISION = {
  parentRunId: 'smoke-root',
  rootRunId: 'smoke-root',
  round: 2,
  action: 'RERUN_IMPLEMENTATION' as const,
  originalTask: 'Original task of the smoke pull request.',
  pullRequest: { number: 8, url: 'https://github.com/o/r/pull/8', headBranch: 'factory/f0001/feat-smoke', baseBranch: 'master' },
  comments: [
    {
      id: 'c1',
      source: 'REVIEW_THREAD' as const,
      author: 'marc',
      body: 'Some findings I see testing the UI:\n- the dark mode is incomplete',
      path: 'src/main/example.ts',
      line: 3,
      category: 'CODE_CHANGE_REQUEST',
    },
  ],
  title: 'Finish dark mode on the investment pages',
};

/**
 * What must hold for a round: it is not named again (it belongs to its task), it keeps the pull
 * request's branch, it is titled by what the triage said it is about, and the PR writer wrote the message
 * of its commit - and only that.
 */
function roundChecks(traceDir: string): Array<[string, boolean, string?]> {
  const read = (file: string): Record<string, any> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(traceDir, file), 'utf8')) as Record<string, any>;
    } catch {
      return null;
    }
  };
  const meta = read('run.json');
  const writer = read('07-pr-writer.json');
  return [
    ['a round is not named again', !fs.existsSync(path.join(traceDir, '00-run-namer.json')), ''],
    ['the round keeps the pull request branch', meta?.branch === 'factory/f0001/feat-smoke', String(meta?.branch)],
    ['the round is recorded as round 2 of its task', meta?.kind === 'revision' && meta?.round === 2 && meta?.rootRunId === 'smoke-root', `${meta?.kind} ${meta?.round}`],
    ['the round is titled by its triage', meta?.title === 'Finish dark mode on the investment pages' && meta?.titleSource === 'round', `${meta?.title} (${meta?.titleSource})`],
    ['the round takes no new task id', meta?.taskId === undefined, String(meta?.taskId)],
    [
      'the PR writer wrote the message of the round\'s commit',
      writer?.status === 'COMPLETED' && writer?.data?.reason === 'ROUND' && String(writer?.data?.commitMessage).startsWith('fix(example): dry-run follow-up'),
      `${writer?.status} ${String(writer?.data?.commitMessage).split('\n')[0]}`,
    ],
    ['the round leaves the pull request title and description alone', writer?.data?.pullRequest?.title === '' && writer?.data?.pullRequest?.body === '', ''],
  ];
}

/**
 * A big request the architect splits into phases: the roadmap is saved, this run is phase 1, and the
 * pull request says so.
 */
async function phasedChecks(traceDir: string): Promise<Array<[string, boolean, string?]>> {
  const { withStore } = await import('../initiatives/store.ts');
  const read = (file: string): Record<string, any> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(traceDir, file), 'utf8')) as Record<string, any>;
    } catch {
      return null;
    }
  };
  const meta = read('run.json');
  const body = String(read('08-pull-request.json')?.data?.pullRequest?.body ?? '');
  const initiative = meta?.initiativeId ? await withStore((store) => store.getInitiative(String(meta.initiativeId))) : null;
  const phases = initiative?.phases ?? [];

  return [
    ['the run is filed under an initiative and a phase', Boolean(meta?.initiativeId) && meta?.phaseId === `${meta?.initiativeId}-p1`, `${meta?.initiativeId} ${meta?.phaseId}`],
    ['the roadmap was saved: a project of three phases', initiative?.kind === 'project' && phases.length === 3, `${initiative?.kind} ${phases.length}`],
    // The smoke asks for no pull request: the run delivers on its branch only, so the phase is not running any
    // more and not in review - it goes back to the roadmap, keeping the task and branch, and says what happened.
    [
      'this run was phase 1: it delivered without a pull request, so the phase went back to the roadmap, with its task, its branch and a note',
      phases[0]?.status === 'PLANNED' &&
        phases[0]?.taskId === meta?.taskId &&
        phases[0]?.branch === meta?.branch &&
        phases[0]?.notes.some((note) => note.source === 'factory' && /without opening a pull request/.test(note.text)),
      `${phases[0]?.status} ${phases[0]?.taskId} ${phases[0]?.notes.map((note) => note.source).join(',')}`,
    ],
    ['the other phases wait, each after the one before it unless told otherwise', phases[1]?.status === 'PLANNED' && phases[1]?.dependsOn.join() === phases[0]?.id && phases[2]?.dependsOn.join() === phases[1]?.id, phases.map((p) => p.dependsOn.join('+')).join(' | ')],
    ['the initiative is named by the architect, not by phase 1', initiative?.title === '[dry-run] Rework the example module', initiative?.title],
    ['the pull request says it is phase 1 of 3', /This pull request is \*\*phase 1 of 3\*\*/.test(body) && /- \[x\] 1\. \[dry-run\] Foundation - \*\*this pull request\*\*/.test(body) && /- \[ \] 2\. \[dry-run\] Screens/.test(body), (/## Roadmap[\s\S]{0,120}/.exec(body) ?? [''])[0]],
    ['the Roadmap comes before the quality gates', body.indexOf('## Roadmap') !== -1 && body.indexOf('## Roadmap') < body.indexOf('## Quality gates'), ''],
  ];
}

/**
 * Phase 2 of that roadmap. It cannot start while phase 1 is not merged; once it is, a run of the phase
 * needs no namer (the phase has its name), takes the phase's title, and is filed under the phase.
 */
async function phaseTwo({ label, traceDir }: { label: string; traceDir: string }): Promise<void> {
  const { withStore } = await import('../initiatives/store.ts');
  const { phaseTask } = await import('../initiatives/phasing.ts');
  const meta = JSON.parse(fs.readFileSync(path.join(traceDir, 'run.json'), 'utf8')) as Record<string, any>;
  const initiativeId = String(meta.initiativeId);
  const phaseId = `${initiativeId}-p2`;
  const workflow = mastra.getWorkflow('softwareFactoryWorkflow');

  const start = async () => {
    const initiative = (await withStore((store) => store.getInitiative(initiativeId)))!;
    const phase = initiative.phases.find((candidate) => candidate.id === phaseId)!;
    const runId = generateRunId('smoke-phase');
    const run = await workflow.createRun({ runId });
    const result = await run.start({
      inputData: {
        task: phaseTask(initiative, phase),
        repo: PROJECT_ROOT,
        maxAttempts: 2,
        autoCommit: false,
        createPullRequest: false,
        interactive: false,
        phase: { initiativeId, phaseId },
      },
    });
    return { runId, result };
  };

  // 1. Phase 1 is still a pull request: phase 2 would be planned against code that is about to change.
  const early = await start();
  check(
    `${label} phase 2 is refused while phase 1 is not merged`,
    early.result.status === 'failed' && /builds on phase 1/.test(String(early.result.error?.message)),
    early.result.status === 'failed' ? String(early.result.error?.message).slice(0, 110) : early.result.status,
  );

  // 2. Phase 1 merged (what `pr-merge` and `pr-check` do): now it starts.
  await withStore((store) => store.markMerged(`${initiativeId}-p1`, { sha: 'abc1234' }));

  // 2a. The merged phase is compared with the roadmap. A rehearsal asks no model, so it only records
  // what the developer said and leaves the phases to come as they were written.
  const { reconcilePhase } = await import('../initiatives/reconcile.ts');
  const report = await reconcilePhase({ phaseId: `${initiativeId}-p1` });
  const afterMerge = (await withStore((store) => store.getInitiative(initiativeId)))!;
  check(
    `${label} a merged phase is reconciled with the roadmap (dry run: recorded, the phases to come untouched)`,
    report?.source === 'none' && Boolean(afterMerge.phases[0]?.summary) && afterMerge.phases.slice(1).every((candidate) => candidate.status === 'PLANNED'),
    `${report?.source} ${afterMerge.phases.map((candidate) => candidate.status).join(',')}`,
  );
  check(`${label} a phase is reconciled once, not on every look`, (await reconcilePhase({ phaseId: `${initiativeId}-p1` })) === null, '');
  const { runId, result } = await start();
  check(`${label} phase 2 runs once phase 1 is merged`, result.status === 'success', result.status);
  if (result.status !== 'success') return;

  const dir = traceDirFor(runId);
  const run2 = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as Record<string, any>;
  const namer = JSON.parse(fs.readFileSync(path.join(dir, '00-run-namer.json'), 'utf8')) as Record<string, any>;
  const calls = fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
  const phase = (await withStore((store) => store.getPhase(phaseId)))!;

  check(`${label} phase 2's run is filed under phase 2`, run2.phaseId === phaseId && run2.initiativeId === initiativeId, `${run2.initiativeId} ${run2.phaseId}`);
  check(`${label} phase 2 is named by its roadmap entry, with no model asked`, namer.data?.source === 'phase' && run2.title === '[dry-run] Screens' && !calls.some((e) => e.role === 'run-namer'), `${run2.title} ${namer.data?.source}`);
  check(`${label} phase 2 has a task id of its own, and a branch from its title`, run2.taskId !== meta.taskId && String(run2.branch).startsWith(`factory/${run2.taskId}/`) && /screens/.test(String(run2.branch)), String(run2.branch));
  check(
    `${label} phase 2 ran with its own task, and (no pull request) went back to the roadmap with a note`,
    phase.status === 'PLANNED' && phase.taskId === run2.taskId && phase.notes.some((note) => note.source === 'factory'),
    `${phase.status} ${phase.taskId}`,
  );
  check(`${label} the pull request of phase 2 says it is phase 2 of 3`, /phase 2 of 3/.test(String(JSON.parse(fs.readFileSync(path.join(dir, '08-pull-request.json'), 'utf8')).data?.pullRequest?.body)), '');
}

const SCENARIOS: ScenarioExpectation[] = [
  {
    scenario: 'happy',
    description: 'plan -> develop -> QA pass -> review+security approve -> docs -> delivery',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 1,
    requiredArtifacts: [
      '00-run-namer.json',
      '01-pm-architect.json',
      '02-developer.json',
      '03-qa-tester.json',
      '05-code-review.json',
      '06-security.json',
      '07-documentation.json',
      '07-pr-writer.json',
      '08-pull-request.json',
      'summary.json',
    ],
    extraChecks: (dir) => [
      ...namingChecks(dir),
      ...polishChecks(dir, { status: 'NONE', gateLine: /- Polish: no minor findings to fix/ }),
      ...gateChecks(dir, { qa: 'PASS', codeReview: 'APPROVED', security: 'PASS', documentation: 'COMPLETED' }),
    ],
  },
  {
    scenario: 'happy',
    description: 'a further round on a pull request: titled by its triage, no new name, the PR writer writes the commit message',
    interactive: false,
    round: true,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 1,
    requiredArtifacts: ['01-pm-architect.json', '02-developer.json', '07-pr-writer.json', '08-pull-request.json', 'summary.json'],
    extraChecks: (dir) => roundChecks(dir),
  },
  {
    scenario: 'polish',
    description: 'the review approves with a minor remark and a nit -> the polish pass fixes the first, only reports the second',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 1,
    requiredArtifacts: ['05-code-review.json', '06-polish.json', '07-pr-writer.json', '08-pull-request.json', 'summary.json'],
    extraChecks: (dir) => [
      ...polishChecks(dir, { status: 'APPLIED', applied: 1, reportedNit: true, gateLine: /- Polish: 1 minor finding fixed \(dry run\)/ }),
      ...gateChecks(dir, { qa: 'PASS', codeReview: 'APPROVED_WITH_SUGGESTIONS', security: 'PASS', documentation: 'COMPLETED' }),
    ],
  },
  {
    scenario: 'phased',
    description: 'a big request: the architect proposes three phases -> a roadmap, this run is phase 1, and phase 2 follows once phase 1 is merged',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 1,
    requiredArtifacts: ['01-pm-architect.json', '07-pr-writer.json', '08-pull-request.json', 'summary.json'],
    extraChecks: phasedChecks,
    then: phaseTwo,
  },
  {
    scenario: 'happy',
    description: 'phasing switched OFF: the architect is told not to split, and no roadmap is made even if it proposes one',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 1,
    phasing: 'off',
    dryRunScenario: 'phased',
    requiredArtifacts: ['01-pm-architect.json', '08-pull-request.json', 'summary.json'],
    extraChecks: async (dir) => {
      const { withStore } = await import('../initiatives/store.ts');
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as Record<string, any>;
      const initiative = await withStore((store) => store.getInitiative(String(meta.initiativeId)));
      const body = String(JSON.parse(fs.readFileSync(path.join(dir, '08-pull-request.json'), 'utf8')).data?.pullRequest?.body ?? '');
      return [
        ['it stays a quick task of one phase', initiative?.kind === 'quick' && initiative.phases.length === 1, `${initiative?.kind} ${initiative?.phases.length}`],
        ['the pull request has no roadmap', !body.includes('## Roadmap'), ''],
      ];
    },
  },
  {
    scenario: 'polish',
    description: 'polish switched OFF: the same remarks are only reported, the developer is not asked',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 1,
    pipeline: { polish: false },
    requiredArtifacts: ['06-polish.json', '08-pull-request.json', 'summary.json'],
    extraChecks: (dir) => [
      ...polishChecks(dir, { status: 'SKIPPED', gateLine: /- Polish: not run \(disabled for this task\)/ }),
      [
        'the minor finding that was not fixed is listed in the pull request instead',
        /## Follow-ups[\s\S]*src\/main\/example\.ts:12: \[dry-run\] A stale comment\.[^\n]*\(not fixed\)/.test(
          String(JSON.parse(fs.readFileSync(path.join(dir, '08-pull-request.json'), 'utf8'))?.data?.pullRequest?.body ?? ''),
        ),
      ],
    ],
  },
  {
    scenario: 'happy',
    description:
      'documentation switched OFF: the commit message and PR text are still written (PR writer is mandatory)',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 1,
    pipeline: { documentation: false },
    requiredArtifacts: ['07-documentation.json', '07-pr-writer.json', '08-pull-request.json', 'summary.json'],
    extraChecks: (dir) => [
      ...prTextChecks(dir, { documentation: 'SKIPPED', expectGates: ['Documentation: not run (disabled for this task)'] }),
      ...gateChecks(dir, { qa: 'PASS', codeReview: 'APPROVED', security: 'PASS', documentation: 'SKIPPED' }),
    ],
  },
  {
    scenario: 'happy',
    description:
      'every optional stage OFF: the PR text is still written, and says plainly that nothing ran',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 1,
    pipeline: { qa: false, review: false, security: false, documentation: false },
    requiredArtifacts: ['07-pr-writer.json', '08-pull-request.json', 'summary.json'],
    extraChecks: (dir) => [
      ...prTextChecks(dir, {
        documentation: 'SKIPPED',
        expectGates: [
          'QA: not run (disabled for this task)',
          'Code review: not run (disabled for this task)',
          'Security audit: not run (disabled for this task)',
          'Documentation: not run (disabled for this task)',
        ],
      }),
      ...gateChecks(dir, { qa: 'SKIPPED', codeReview: 'SKIPPED', security: 'SKIPPED', documentation: 'SKIPPED' }),
    ],
  },
  {
    scenario: 'retry',
    description: 'QA fails -> triage RETRY_DEVELOPER -> second attempt passes',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 2,
    requiredArtifacts: [
      '02-developer.json',
      '03-qa-tester.json',
      '04-triage.json',
      '02-developer.attempt-2.json',
      '03-qa-tester.attempt-2.json',
      'summary.json',
    ],
  },
  {
    scenario: 'infra',
    description: 'QA fails on environment -> triage RE-RUN_INFRA -> developer skipped -> pass',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 2,
    requiredArtifacts: ['04-triage.json', '02-developer.attempt-2.json', 'summary.json'],
  },
  {
    scenario: 'review-changes',
    description: 'QA passes but review requests changes -> triage -> fixed on attempt 2',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 2,
    requiredArtifacts: ['05-code-review.json', '04-triage.json', '05-code-review.attempt-2.json'],
  },
  {
    scenario: 'security-block',
    description: 'security audit blocks the change -> triage -> fixed on attempt 2',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 2,
    requiredArtifacts: ['06-security.json', '04-triage.json', '06-security.attempt-2.json'],
  },
  {
    scenario: 'escalate',
    description: 'repeated identical failure -> loop detected -> suspend for human',
    interactive: true,
    expect: 'suspended',
    resume: { data: { decision: 'ACKNOWLEDGE', guidance: 'Use HALF_UP rounding.' }, expect: 'ESCALATED_TO_HUMAN' },
    requiredArtifacts: ['04-triage.json', '09-escalation.json'],
  },
  {
    scenario: 'escalate',
    description: 'same failure in CI mode -> escalation recorded without suspending',
    interactive: false,
    expect: 'ESCALATED_TO_HUMAN',
    requiredArtifacts: ['09-escalation.json', 'summary.json'],
  },
  {
    scenario: 'clarify',
    description: 'blocking ambiguity -> suspend -> resume with clarifications -> delivery',
    interactive: true,
    expect: 'suspended',
    resume: { data: { clarifications: 'Round half-cent amounts up (HALF_UP).' }, expect: 'DELIVERED_WITHOUT_PR' },
    requiredArtifacts: ['01-pm-architect.json'],
  },
];

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}\n`);
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function runScenario(expectation: ScenarioExpectation, index: number): Promise<void> {
  process.env.FACTORY_DRY_RUN_SCENARIO = expectation.dryRunScenario ?? expectation.scenario;
  process.env.FACTORY_NON_INTERACTIVE = expectation.interactive ? 'false' : 'true';

  const label = `[${index + 1}/${SCENARIOS.length}] ${expectation.scenario}${
    expectation.interactive ? ' (interactive)' : ' (ci)'
  }`;
  process.stdout.write(`\n${label}: ${expectation.description}\n`);

  const workflow = mastra.getWorkflow('softwareFactoryWorkflow');
  const runId = generateRunId(`smoke-${expectation.scenario}`);
  const run = await workflow.createRun({ runId });

  let result = await run.start({
    inputData: {
      task: `Smoke test the factory graph for the "${expectation.scenario}" scenario.`,
      repo: PROJECT_ROOT,
      maxAttempts: 2,
      autoCommit: false,
      createPullRequest: false,
      interactive: expectation.interactive,
      ...(expectation.pipeline ? { pipeline: expectation.pipeline } : {}),
      ...(expectation.phasing ? { phasing: expectation.phasing } : {}),
      ...(expectation.round
        ? { revision: SMOKE_REVISION, baseBranch: 'master', branchName: SMOKE_REVISION.pullRequest.headBranch }
        : {}),
    },
  });

  if (expectation.expect === 'suspended') {
    check(`${label} suspends for human input`, result.status === 'suspended', `status=${result.status}`);
    if (result.status === 'suspended') {
      check(
        `${label} suspend payload is actionable`,
        JSON.stringify(result.suspendPayload ?? {}).length > 20,
        JSON.stringify(result.suspendPayload).slice(0, 110),
      );
    }

    if (expectation.resume) {
      const resumeRun = await workflow.createRun({ runId });
      result = await resumeRun.resume({ resumeData: expectation.resume.data as never });
      check(
        `${label} resumes to ${expectation.resume.expect}`,
        result.status === 'success' && result.result.status === expectation.resume.expect,
        result.status === 'success' ? `status=${result.result.status}` : `status=${result.status}`,
      );
    }
  } else {
    check(
      `${label} completes with ${expectation.expect}`,
      result.status === 'success' && result.result.status === expectation.expect,
      result.status === 'success'
        ? `status=${result.result.status}`
        : `status=${result.status} ${
            result.status === 'failed' ? (result.error?.message ?? '') : ''
          }`,
    );
  }

  if (result.status === 'failed') {
    process.stderr.write(`${result.error?.stack ?? result.error?.message ?? 'unknown error'}\n`);
    return;
  }

  if (expectation.expectedAttempts !== undefined && result.status === 'success') {
    check(
      `${label} used ${expectation.expectedAttempts} attempt(s)`,
      result.result.attempts === expectation.expectedAttempts,
      `attempts=${result.result.attempts}`,
    );
  }

  const traceDir = traceDirFor(runId);
  const present = fs.existsSync(traceDir) ? fs.readdirSync(traceDir) : [];
  const missing = expectation.requiredArtifacts.filter((artifact) => !present.includes(artifact));
  check(`${label} writes the expected artifacts`, missing.length === 0, missing.length > 0 ? `missing: ${missing.join(', ')}` : `${present.length} files`);

  for (const [name, ok, detail] of (await expectation.extraChecks?.(traceDir)) ?? []) {
    check(`${label} ${name}`, ok, detail ?? '');
  }

  check(
    `${label} writes the run event log`,
    fs.existsSync(path.join(traceDir, 'events.ndjson')),
  );

  await expectation.then?.({ label, traceDir });

  const summaryPath = path.join(traceDir, 'summary.json');
  if (fs.existsSync(summaryPath)) {
    const summary = readJsonFile(summaryPath);
    const steps = (summary?.steps as unknown[] | undefined) ?? [];
    const models = (summary?.modelsUsed as unknown[] | undefined) ?? [];
    check(
      `${label} summary.json is complete`,
      Boolean(summary?.runId) &&
        Boolean(summary?.status) &&
        typeof summary?.durationMs === 'number' &&
        Boolean(summary?.tokens) &&
        steps.length > 0 &&
        models.length > 0,
      `steps=${steps.length} models=${models.length} agentCalls=${String(summary?.agentCalls)}`,
    );
  }
}

/* -------------------------------------------------------------------------- */

const onlyScenario = process.argv.includes('--scenario')
  ? process.argv[process.argv.indexOf('--scenario') + 1]
  : undefined;

const selected = onlyScenario
  ? SCENARIOS.filter((entry) => entry.scenario === onlyScenario)
  : SCENARIOS;

process.stdout.write(
  `\nFactory graph smoke test (dry run, no LLM calls)\nscenarios: ${selected.length}\n`,
);

for (const [index, expectation] of selected.entries()) {
  try {
    await runScenario(expectation, index);
  } catch (error) {
    check(
      `[${index + 1}] ${expectation.scenario} threw`,
      false,
      error instanceof Error ? error.message : String(error),
    );
    if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  }
}

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(
  `\n${'-'.repeat(60)}\n${results.length - failed.length}/${results.length} checks passed\n`,
);
if (failed.length > 0) {
  process.stdout.write(`\nFailed checks:\n${failed.map((entry) => `  - ${entry.name}: ${entry.detail}`).join('\n')}\n`);
}

if (isolatedLogDir) {
  if (failed.length === 0) {
    fs.rmSync(isolatedLogDir, { recursive: true, force: true });
  } else {
    process.stdout.write(`\nTraces of this run were kept in ${isolatedLogDir}\n`);
  }
}

process.exit(failed.length === 0 ? 0 : 1);
