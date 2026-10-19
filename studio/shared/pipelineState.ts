/**
 * Derives the pipeline view (which steps exist, which one is running, which were skipped,
 * what was asked of the human, ...) from what the factory persisted on disk.
 *
 * Why this is a pure function of persisted data and not a reaction to the live log stream:
 * the view used to learn "step X is running" only from log lines it happened to receive. When
 * the user switched to another repository and came back, the component was mounted afresh -
 * every step `pending`, the earlier lines gone - and the blue "running" marker stayed off
 * until the *next* line arrived, which during a long agent call can be a minute away.
 * Artifacts, the event log and the run lifecycle are all on disk, so the same inputs always
 * produce the same pipeline, whenever and however often the view is opened.
 *
 * No React, no Node, no Electron here: it is exercised directly against real run directories.
 */
import type { PendingInput, PipelineConfig, RunArtifact, RunEventRecord } from './types';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type NodeStatus =
  | 'pending'
  | 'running'
  | 'waiting' // paused on a human gate
  | 'completed'
  | 'failed'
  | 'retry'
  | 'skipped';

/** Which detail view renders a node. */
export type NodeKind = 'step' | 'pm-questions' | 'clarification' | 'escalation';

export interface PipelineNode {
  /** Stable id used for selection: `developer-2`, `reviewer`, `clarification-1`, ... */
  id: string;
  name: string;
  icon: string;
  status: NodeStatus;
  attempt: number;
  kind: NodeKind;
  /** Artifact step name backing this node (`code-review` for the reviewer), when there is one. */
  artifactStep?: string;
  /** One line describing what the node is doing / waiting for. */
  activity?: string;
  /** True when the stage was switched off for this task. */
  disabled?: boolean;
}

/** A question the architect asked and the answer the human gave. */
export interface HumanExchange {
  gate: 'CLARIFICATION_REQUIRED';
  askedAt?: string;
  questions: string[];
  /** The architect's first-pass reading of the task (its artifact is overwritten by pass two). */
  planSummary?: string;
  answer?: string;
  answeredAt?: string;
  /** True while the run is still waiting for the answer. */
  open: boolean;
}

export type Lifecycle = 'running' | 'waiting' | 'failed' | 'done';

export interface DeriveInput {
  artifacts: RunArtifact[];
  events: RunEventRecord[];
  pendingInput: PendingInput | null;
  /** Backend-derived run status. `null` until the first load. */
  runStatus: string | null | undefined;
  /** What the caller believes before `runStatus` is known (e.g. a run that was just started). */
  assumeAlive: boolean;
  /** Which optional stages this run uses. */
  pipeline: PipelineConfig;
  /** Workflow step the backend says failed, if it knows. */
  failedStep?: string | null;
}

export interface DerivedPipeline {
  nodes: PipelineNode[];
  /** Ids of the nodes executing right now (review and security overlap). */
  runningIds: string[];
  exchanges: HumanExchange[];
  lifecycle: Lifecycle;
  /** Highest attempt number seen. */
  attempt: number;
  /** Node blamed for a failed run. */
  failedNodeId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Step vocabulary                                                             */
/* -------------------------------------------------------------------------- */

/** Artifact step names that differ from the node ids the view uses. */
const STEP_ALIASES: Record<string, string> = {
  'code-review': 'reviewer',
  'pull-request': 'delivery',
};

export const normalizeStep = (step: string): string => STEP_ALIASES[step] ?? step;

/** `developer-2` -> `developer`; ids without an attempt suffix are returned unchanged. */
export const baseStepId = (id: string): string => id.replace(/-\d+$/, '');

/** Steps that run once per develop/QA attempt. */
const PER_ATTEMPT = new Set(['developer', 'qa-tester', 'reviewer', 'security', 'triage']);

/** Workflow step ids reported by the backend -> the node family they belong to. */
const FAILED_STEP_FAMILY: Record<string, string> = {
  'prepare-run': 'prepare-run',
  plan: 'pm-architect',
  'pm-architect': 'pm-architect',
  developer: 'developer',
  'qa-tester': 'qa-tester',
  triage: 'triage',
  'triage-qa': 'triage',
  'code-review': 'reviewer',
  reviewer: 'reviewer',
  security: 'security',
  documentation: 'documentation',
  'pr-writer': 'pr-writer',
  'pull-request': 'delivery',
  delivery: 'delivery',
  escalation: 'escalation',
};

/* -------------------------------------------------------------------------- */
/* Artifact status -> node status                                              */
/* -------------------------------------------------------------------------- */

export function developerStatus(raw: string): NodeStatus {
  const s = raw.toUpperCase();
  if (s === 'COMPLETED' || s === 'PASS') return 'completed';
  if (s.startsWith('SKIPPED')) return 'skipped';
  return 'failed';
}

export function qaStatus(raw: string): NodeStatus {
  const s = raw.toUpperCase();
  if (s === 'SKIPPED') return 'skipped';
  if (s === 'PASS') return 'completed';
  if (s === 'FAIL' || s === 'FAILED') return 'failed';
  return 'retry'; // BLOCKED: the cycle goes around again
}

export function reviewStatus(raw: string): NodeStatus {
  const s = raw.toUpperCase();
  if (s === 'SKIPPED') return 'skipped';
  if (s === 'CHANGES_REQUESTED') return 'retry';
  if (s.startsWith('APPROVED') || s === 'COMPLETED' || s === 'PASS') return 'completed';
  return 'failed';
}

/** Security artifacts are written as `<status>/<riskLevel>`, e.g. `PASS/NONE`. */
export function securityStatus(raw: string): NodeStatus {
  const head = (raw.toUpperCase().split('/')[0] ?? '').trim();
  if (head === 'SKIPPED') return 'skipped';
  if (head === 'CHANGES_REQUESTED') return 'retry';
  if (head.startsWith('PASS') || head === 'COMPLETED') return 'completed';
  return 'failed';
}

export function documentationStatus(raw: string): NodeStatus {
  const s = raw.toUpperCase();
  if (s === 'SKIPPED') return 'skipped';
  if (s === 'COMPLETED' || s === 'PARTIAL') return 'completed';
  return 'failed';
}

/**
 * The PR writer's artifact: COMPLETED | FALLBACK (the AI could not answer, so the text was drafted from
 * the run's reports - the step still produced what delivery needs) | SKIPPED (a round on an existing
 * pull request, or nothing changed: no text to write).
 */
export function prWriterStatus(raw: string): NodeStatus {
  const s = raw.toUpperCase();
  if (s === 'SKIPPED') return 'skipped';
  if (s === 'COMPLETED' || s === 'FALLBACK') return 'completed';
  return 'failed';
}

/** A triage artifact's status is its *decision*; the step itself succeeded whatever it decided. */
export function triageStatus(_raw: string): NodeStatus {
  return 'completed';
}

export function pmStatus(raw: string): NodeStatus {
  const s = raw.toUpperCase();
  // REUSED: a round on a pull request that kept the previous round's plan. The architect did not
  // run in this round, so it is shown as skipped (with the reason) rather than as work it did.
  if (s === 'REUSED') return 'skipped';
  if (s === 'COMPLETED') return 'completed';
  if (s === 'CLARIFICATION_REQUIRED') return 'waiting';
  return 'failed';
}

/**
 * Statuses the delivery step writes: PR_CREATED | PR_UPDATED (a round pushed to an open pull
 * request) | PUSHED | COMMITTED | NO_CHANGES | *_FAILED.
 */
export function deliveryStatus(raw: string): NodeStatus {
  const s = raw.toUpperCase();
  if (s === 'PR_CREATED' || s === 'PR_UPDATED' || s === 'PUSHED' || s === 'COMMITTED') return 'completed';
  if (s === 'NO_CHANGES') return 'skipped'; // ran, but nothing was published
  return 'failed'; // PUSH_FAILED | PR_FAILED | FAILED
}

export const isDeliveryFailure = (raw: string): boolean => deliveryStatus(raw) === 'failed';

/* -------------------------------------------------------------------------- */
/* Artifact index                                                              */
/* -------------------------------------------------------------------------- */

interface ArtifactIndex {
  get(step: string, attempt: number): RunArtifact | undefined;
  latest(step: string): RunArtifact | undefined;
  maxAttempt: number;
}

function indexArtifacts(artifacts: RunArtifact[]): ArtifactIndex {
  const byStep = new Map<string, Map<number, RunArtifact>>();
  let maxAttempt = 1;

  for (const artifact of artifacts) {
    const step = normalizeStep(artifact.step);
    const attempt = artifact.attempt || 1;
    let attempts = byStep.get(step);
    if (!attempts) {
      attempts = new Map();
      byStep.set(step, attempts);
    }
    attempts.set(attempt, artifact); // artifacts are rewritten in place: the last one wins
    if (PER_ATTEMPT.has(step)) maxAttempt = Math.max(maxAttempt, attempt);
  }

  return {
    maxAttempt,
    get: (step, attempt) => byStep.get(step)?.get(attempt),
    latest: (step) => {
      const attempts = byStep.get(step);
      if (!attempts || attempts.size === 0) return undefined;
      return attempts.get(Math.max(...attempts.keys()));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Human exchanges                                                             */
/* -------------------------------------------------------------------------- */

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => String(entry)) : [];

/**
 * Rebuilds the question -> answer exchanges with the architect.
 *
 * The architect's artifact is rewritten on its second pass, so the first pass survives only in
 * the event log (`run_suspended` carries the questions) and the answer in a `human_input`
 * event. Runs recorded before `human_input` existed still carry the answer as
 * `clarificationsUsed` in the final plan.
 */
export function buildExchanges(
  events: RunEventRecord[],
  pm: RunArtifact | undefined,
  pendingInput: PendingInput | null,
): HumanExchange[] {
  const asked = events.filter(
    (e) => e.type === 'run_suspended' && e.reason === 'CLARIFICATION_REQUIRED',
  );
  const answered = events.filter(
    (e) => e.type === 'human_input' && e.gate === 'CLARIFICATION_REQUIRED',
  );

  const exchanges: HumanExchange[] = asked.map((event, index) => {
    const answer = answered[index]?.answer;
    return {
      gate: 'CLARIFICATION_REQUIRED',
      askedAt: event.at,
      questions: asStringArray(event.questions),
      planSummary: typeof event.planSummary === 'string' ? event.planSummary : undefined,
      answer: typeof answer === 'string' ? answer : undefined,
      answeredAt: answered[index]?.at,
      open: false,
    };
  });

  const planData = (pm?.data ?? {}) as {
    clarificationsUsed?: unknown;
    plan?: { clarificationQuestions?: unknown };
  };

  // Older run: no `human_input` event, but the final plan records what the human answered.
  const used = planData.clarificationsUsed;
  if (exchanges.length > 0 && typeof used === 'string' && used.trim() !== '') {
    const last = exchanges[exchanges.length - 1]!;
    if (last.answer === undefined && pm?.status !== 'CLARIFICATION_REQUIRED') {
      last.answer = used;
      last.answeredAt = pm?.writtenAt;
    }
  }

  // Architect asked, but there is no event for it (very old run): use the artifact itself.
  if (exchanges.length === 0 && pm?.status === 'CLARIFICATION_REQUIRED') {
    exchanges.push({
      gate: 'CLARIFICATION_REQUIRED',
      askedAt: pm.writtenAt,
      questions: asStringArray(planData.plan?.clarificationQuestions),
      open: false,
    });
  }

  // The run is paused on this very question right now.
  if (pendingInput?.reason === 'CLARIFICATION_REQUIRED') {
    const last = exchanges[exchanges.length - 1];
    if (last && last.answer === undefined) {
      last.open = true;
      if (last.questions.length === 0) last.questions = pendingInput.questions ?? [];
      if (!last.planSummary) last.planSummary = pendingInput.planSummary;
    } else {
      exchanges.push({
        gate: 'CLARIFICATION_REQUIRED',
        questions: pendingInput.questions ?? [],
        planSummary: pendingInput.planSummary,
        open: true,
      });
    }
  }

  return exchanges;
}

/* -------------------------------------------------------------------------- */
/* Frontier: which step(s) are executing                                       */
/* -------------------------------------------------------------------------- */

interface FrontierContext {
  idx: ArtifactIndex;
  pipeline: PipelineConfig;
  prepareDone: boolean;
}

const isDone = (status: NodeStatus): boolean => status === 'completed' || status === 'skipped';

/**
 * The step(s) the workflow is executing, inferred from which artifacts already exist.
 *
 * The graph is sequential - develop -> QA -> (triage | review + security) -> documentation ->
 * delivery - apart from review and security, which run in parallel and therefore can both be
 * "running" at once. A stage switched off in the pipeline is treated as already done: the
 * workflow writes its `SKIPPED` artifact within milliseconds, so it must never flash as running.
 */
function inferFrontier({ idx, pipeline, prepareDone }: FrontierContext): string[] {
  if (!prepareDone) return ['prepare-run'];

  const pm = idx.latest('pm-architect');
  if (!pm) return ['pm-architect'];
  // The architect asked and the human answered: the second pass is (about to be) running.
  if (pm.status === 'CLARIFICATION_REQUIRED') return ['pm-architect-plan'];

  const attempt = idx.maxAttempt;
  const nextAttempt = `developer-${attempt + 1}`;

  if (!idx.get('developer', attempt)) return [`developer-${attempt}`];

  const qa = idx.get('qa-tester', attempt);
  if (!qa && pipeline.qa !== false) return [`qa-tester-${attempt}`];
  if (qa && !isDone(qaStatus(qa.status))) {
    return idx.get('triage', attempt) ? [nextAttempt] : [`triage-${attempt}`];
  }

  const review = idx.get('reviewer', attempt);
  const security = idx.get('security', attempt);
  const verifying: string[] = [];
  if (!review && pipeline.review !== false) verifying.push('reviewer');
  if (!security && pipeline.security !== false) verifying.push('security');
  if (verifying.length > 0) return verifying;

  const needsRework =
    (review && reviewStatus(review.status) === 'retry') ||
    (security && securityStatus(security.status) === 'retry');
  if (needsRework) {
    return idx.get('triage', attempt) ? [nextAttempt] : [`triage-${attempt}`];
  }

  if (!idx.latest('documentation') && pipeline.documentation !== false) return ['documentation'];

  // The PR writer has no switch: it always runs next. A run that already reached delivery without
  // its artifact was made before the step existed - nothing is "running" there.
  const delivery = idx.latest('delivery');
  if (!idx.latest('pr-writer') && !delivery) return ['pr-writer'];

  // A failed delivery artifact is stale while the step is being retried.
  if (!delivery || isDeliveryFailure(delivery.status)) return ['delivery'];

  return [];
}

/* -------------------------------------------------------------------------- */
/* Activity captions                                                           */
/* -------------------------------------------------------------------------- */

const RUNNING_ACTIVITY: Record<string, string> = {
  'prepare-run': 'Preparing the repository and work branch...',
  'pm-architect': 'Analysing the task and the codebase...',
  'pm-architect-plan': 'Re-planning with your answers...',
  developer: 'Writing code and implementing the plan...',
  'qa-tester': 'Running the build and the test suite...',
  triage: 'Diagnosing what went wrong...',
  reviewer: 'Reviewing the diff...',
  security: 'Auditing the change for vulnerabilities...',
  documentation: 'Checking whether the documentation needs updating...',
  'pr-writer': 'Writing the commit message and the pull-request description...',
};

function deliveryActivity(events: RunEventRecord[]): string {
  // Only the current attempt: after a retry, earlier actions (e.g. a push that already
  // happened) would otherwise make the caption claim progress this attempt has not made yet.
  let from = 0;
  events.forEach((e, i) => {
    if (e.type === 'human_input' && e.gate === 'DELIVERY_APPROVAL_REQUIRED') from = i;
  });
  const actions = events.slice(from).filter((e) => e.type === 'delivery_action');
  const has = (action: string) => actions.some((e) => e.action === action && e.ok === true);
  if (has('pull-request')) return 'Pull request opened.';
  if (has('push')) return 'Branch pushed - opening the pull request...';
  if (has('commit')) return 'Committed - pushing the branch...';
  return 'Committing, pushing and opening the pull request...';
}

/* -------------------------------------------------------------------------- */
/* Derivation                                                                  */
/* -------------------------------------------------------------------------- */

interface NodeSpec {
  id: string;
  name: string;
  icon: string;
  kind: NodeKind;
  attempt: number;
  artifactStep?: string;
  art?: RunArtifact;
  map?: (status: string) => NodeStatus;
  /** Completed without needing an artifact (prepare, the architect's question pass). */
  done?: boolean;
  disabled?: boolean;
}

const attemptOf = (id: string): number => {
  const match = id.match(/-(\d+)$/);
  return match ? Number.parseInt(match[1]!, 10) : 1;
};

export function derivePipeline(input: DeriveInput): DerivedPipeline {
  const { artifacts, events, pendingInput, pipeline } = input;
  const idx = indexArtifacts(artifacts);

  const suspended = pendingInput !== null || input.runStatus === 'SUSPENDED';
  const alive =
    !suspended &&
    (input.runStatus === 'RUNNING' || (input.runStatus == null && input.assumeAlive));
  const failed = !suspended && !alive && input.runStatus === 'FAILED';
  const lifecycle: Lifecycle = suspended ? 'waiting' : alive ? 'running' : failed ? 'failed' : 'done';

  const prepareDone =
    events.some((e) => e.type === 'step_completed' && e.step === 'prepare-run') ||
    artifacts.length > 0;

  const pm = idx.latest('pm-architect');
  const exchanges = buildExchanges(events, pm, pendingInput);
  const exchange = exchanges[0];

  // Which node(s) execute now - or, for a failed run, which one the failure belongs to.
  const frontier =
    lifecycle === 'running' || lifecycle === 'failed'
      ? inferFrontier({ idx, pipeline, prepareDone })
      : [];

  // The attempt cycle may have moved on to a developer node that has no artifact yet.
  const shownAttempts = Math.max(idx.maxAttempt, ...frontier.map(attemptOf));

  /* ---- node specs, in pipeline order ---- */
  const specs: NodeSpec[] = [];

  specs.push({
    id: 'prepare-run',
    name: 'Prepare',
    icon: '⚙️',
    kind: 'step',
    attempt: 1,
    done: prepareDone,
  });

  if (exchange) {
    specs.push({
      id: 'pm-architect',
      name: 'PM Architect',
      icon: '📋',
      kind: 'pm-questions',
      attempt: 1,
      done: true,
    });
    specs.push({
      id: 'clarification-1',
      name: 'Clarification',
      icon: '💬',
      kind: 'clarification',
      attempt: 1,
      done: exchange.answer !== undefined && !exchange.open,
    });
    specs.push({
      id: 'pm-architect-plan',
      name: 'PM Plan',
      icon: '📝',
      kind: 'step',
      attempt: 1,
      artifactStep: 'pm-architect',
      // While the second pass has not finished, the artifact still holds the first pass.
      art: pm && pm.status !== 'CLARIFICATION_REQUIRED' ? pm : undefined,
      map: pmStatus,
    });
  } else {
    specs.push({
      id: 'pm-architect',
      name: 'PM Architect',
      icon: '📋',
      kind: 'step',
      attempt: pm?.attempt ?? 1,
      artifactStep: 'pm-architect',
      art: pm,
      map: pmStatus,
    });
  }

  for (let attempt = 1; attempt <= shownAttempts; attempt += 1) {
    const dev = idx.get('developer', attempt);
    if (attempt === 1 || dev || frontier.includes(`developer-${attempt}`)) {
      specs.push({
        id: `developer-${attempt}`,
        name: `Dev ${attempt}`,
        icon: '💻',
        kind: 'step',
        attempt,
        artifactStep: 'developer',
        art: dev,
        map: developerStatus,
      });
    }

    const qa = idx.get('qa-tester', attempt);
    if (attempt === 1 || qa || frontier.includes(`qa-tester-${attempt}`)) {
      specs.push({
        id: `qa-tester-${attempt}`,
        name: `QA ${attempt}`,
        icon: '🧪',
        kind: 'step',
        attempt,
        artifactStep: 'qa-tester',
        art: qa,
        map: qaStatus,
        disabled: pipeline.qa === false,
      });
    }

    const triage = idx.get('triage', attempt);
    if (triage || frontier.includes(`triage-${attempt}`)) {
      specs.push({
        id: `triage-${attempt}`,
        name: `Triage ${attempt}`,
        icon: '🔍',
        kind: 'step',
        attempt,
        artifactStep: 'triage',
        art: triage,
        map: triageStatus,
      });
    }
  }

  const escalation = idx.latest('escalation');
  if (escalation || pendingInput?.reason === 'ESCALATION_REQUIRED') {
    specs.push({
      id: 'escalation',
      name: 'Escalation',
      icon: '🚨',
      kind: 'escalation',
      attempt: escalation?.attempt ?? 1,
      artifactStep: 'escalation',
      art: escalation,
      map: () => 'completed', // a recorded human decision closes it
    });
  }

  const single: Array<{
    id: string;
    name: string;
    icon: string;
    step: string;
    map: (s: string) => NodeStatus;
    disabled: boolean;
  }> = [
    { id: 'reviewer', name: 'Review', icon: '👀', step: 'reviewer', map: reviewStatus, disabled: pipeline.review === false },
    { id: 'security', name: 'Security', icon: '🔒', step: 'security', map: securityStatus, disabled: pipeline.security === false },
    { id: 'documentation', name: 'Docs', icon: '📝', step: 'documentation', map: documentationStatus, disabled: pipeline.documentation === false },
    // Mandatory: no `disabled`, whatever the pipeline selection says.
    { id: 'pr-writer', name: 'PR Writer', icon: '✍️', step: 'pr-writer', map: prWriterStatus, disabled: false },
  ];
  // A run that has reached delivery without a PR writer artifact is from before the step existed:
  // showing the node as "not started" for ever would be wrong, so it is left out.
  const reachedDelivery = idx.latest('delivery') !== undefined || pendingInput?.reason === 'DELIVERY_APPROVAL_REQUIRED';
  for (const entry of single) {
    const art = idx.latest(entry.step);
    if (entry.id === 'pr-writer' && !art && reachedDelivery) continue;
    specs.push({
      id: entry.id,
      name: entry.name,
      icon: entry.icon,
      kind: 'step',
      attempt: art?.attempt ?? 1,
      artifactStep: entry.step,
      art,
      map: entry.map,
      disabled: entry.disabled,
    });
  }

  const delivery = idx.latest('delivery');
  specs.push({
    id: 'delivery',
    name: 'Delivery',
    icon: '🚀',
    kind: 'step',
    attempt: delivery?.attempt ?? 1,
    artifactStep: 'delivery',
    art: delivery,
    map: deliveryStatus,
  });

  /* ---- resolve lifecycle-dependent markers ---- */
  const runningIds = new Set(lifecycle === 'running' ? frontier : []);

  const waitingId =
    lifecycle !== 'waiting'
      ? null
      : pendingInput?.reason === 'CLARIFICATION_REQUIRED'
        ? 'clarification-1'
        : pendingInput?.reason === 'DELIVERY_APPROVAL_REQUIRED'
          ? 'delivery'
          : pendingInput?.reason === 'ESCALATION_REQUIRED'
            ? 'escalation'
            : null;

  let failedNodeId: string | null = null;
  if (lifecycle === 'failed') {
    failedNodeId = frontier[0] ?? null;
    if (!failedNodeId && input.failedStep) {
      // Everything has an artifact, yet the run failed (e.g. in the finalize step): blame the
      // last node of the family the backend names.
      const family = FAILED_STEP_FAMILY[input.failedStep.split('.').pop() ?? ''] ?? null;
      const ofFamily = specs.filter((spec) => baseStepId(spec.id) === family);
      failedNodeId = ofFamily[ofFamily.length - 1]?.id ?? null;
    }
  }

  const nodes: PipelineNode[] = specs.map((spec) => {
    let status: NodeStatus;
    if (runningIds.has(spec.id)) status = 'running';
    else if (waitingId === spec.id) status = 'waiting';
    else if (failedNodeId === spec.id && !spec.art) status = 'failed';
    else if (spec.done) status = 'completed';
    else if (spec.art) status = spec.map ? spec.map(spec.art.status) : 'completed';
    else if (spec.disabled) status = 'skipped';
    else status = 'pending';

    // Precedence above: a live marker beats everything, then a recorded artifact decides. So a
    // stage that was switched off yet produced real output (runs from before the CLI honoured
    // the toggle) is shown for what it actually did, and only never-run stages read as skipped.
    let activity: string | undefined;
    if (status === 'running') {
      activity = spec.id === 'delivery' ? deliveryActivity(events) : RUNNING_ACTIVITY[baseStepId(spec.id)];
    } else if (status === 'waiting') {
      activity =
        spec.id === 'clarification-1'
          ? 'Waiting for your answers'
          : spec.id === 'delivery'
            ? 'Waiting for your approval to push and open a pull request'
            : 'Waiting for your decision';
    } else if (status === 'skipped' && spec.disabled && !spec.art) {
      activity = 'Disabled for this task';
    } else if (status === 'skipped' && spec.art?.status === 'REUSED') {
      activity = 'Skipped: the plan of the previous round is reused';
    } else if (status === 'skipped' && spec.id === 'pr-writer') {
      activity =
        spec.art?.data?.reason === 'ROUND'
          ? 'Skipped: the pull request already has its title and description'
          : 'Skipped: there was nothing to describe';
    }

    return {
      id: spec.id,
      name: spec.name,
      icon: spec.icon,
      status,
      attempt: spec.attempt,
      kind: spec.kind,
      artifactStep: spec.artifactStep,
      activity,
      disabled: spec.disabled,
    };
  });

  return {
    nodes,
    runningIds: [...runningIds],
    exchanges,
    lifecycle,
    attempt: idx.maxAttempt,
    failedNodeId,
  };
}

/** Steps whose node shows the artifact of *its own* attempt (the others show the latest one). */
const ATTEMPT_SCOPED = new Set(['developer', 'qa-tester', 'triage']);

/** The artifact that backs a node. */
export function artifactForNode(node: PipelineNode, artifacts: RunArtifact[]): RunArtifact | undefined {
  if (!node.artifactStep) return undefined;
  const idx = indexArtifacts(artifacts);
  // The PM plan node shows the *final* artifact; while pass two runs there is none to show.
  if (node.id === 'pm-architect-plan') {
    const pm = idx.latest('pm-architect');
    return pm && pm.status !== 'CLARIFICATION_REQUIRED' ? pm : undefined;
  }
  return ATTEMPT_SCOPED.has(node.artifactStep)
    ? idx.get(node.artifactStep, node.attempt)
    : idx.latest(node.artifactStep);
}

/* -------------------------------------------------------------------------- */
/* Log lines                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Message of a `[factory]` log line, lower-cased, or null for anything else.
 *
 * Only the message itself counts: the task text and branch name are echoed on many lines
 * (`branch: "factory/review-the-readme..."`), and matching the whole line made a task like
 * "review the readme" light up the Review step. Handles Mastra's pretty format
 * (`INFO [timestamp] (name): [factory] msg`) and pino JSON (`{"msg":"[factory] ..."}`).
 */
export function extractFactoryMessage(line: string): string | null {
  const json = line.match(/"msg"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const message = json
    ? json[1]!
    : line.includes('[factory]')
      ? line.slice(line.indexOf('[factory]'))
      : null;
  if (!message) return null;
  const lower = message.toLowerCase();
  return lower.includes('[factory]') ? lower : null;
}

/** Epoch ms of a log line's timestamp, in Mastra's pretty format or pino JSON. */
export function parseLineTime(line: string): number | null {
  const pretty = line.match(
    /\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) ([+-]\d{2})(\d{2})\]/,
  );
  if (pretty) {
    const ms = Date.parse(`${pretty[1]}T${pretty[2]}${pretty[3]}:${pretty[4]}`);
    return Number.isNaN(ms) ? null : ms;
  }
  const json = line.match(/"time"\s*:\s*(\d{13})/);
  return json ? Number(json[1]) : null;
}

interface Phase {
  ids: string[];
  until: number;
}

/**
 * Time windows of the run: each ends when the step's artifact (or the gate it paused on) was
 * written. A log line belongs to the first window that ends at or after its timestamp. This is
 * driven by persisted timestamps rather than by message text, so it holds for any logger format.
 */
function buildPhases(events: RunEventRecord[], hasExchange: boolean): Phase[] {
  const phases: Phase[] = [];
  const time = (e: RunEventRecord): number => Date.parse(e.at);

  const suspendedAt = events.find((e) => e.type === 'run_suspended' && e.reason === 'CLARIFICATION_REQUIRED');
  const answeredAt = events.find((e) => e.type === 'human_input' && e.gate === 'CLARIFICATION_REQUIRED');

  for (const event of events) {
    const t = time(event);
    if (Number.isNaN(t)) continue;

    if (event.type === 'step_completed' && event.step === 'prepare-run') {
      phases.push({ ids: ['prepare-run'], until: t });
      continue;
    }
    if (event.type !== 'step_artifact') continue;

    const step = normalizeStep(String(event.step));
    const attempt = Number(event.attempt) || 1;

    if (step === 'pm-architect') {
      if (hasExchange) {
        const asked = suspendedAt ? time(suspendedAt) : t;
        const answered = answeredAt ? time(answeredAt) : asked;
        // First artifact event == the questions; the later one is the final plan.
        if (t <= asked + 1000 && !phases.some((p) => p.ids[0] === 'pm-architect')) {
          phases.push({ ids: ['pm-architect'], until: asked });
          // Strictly before the answer: a line stamped in the very same millisecond as the
          // answer ("clarification received, re-planning") starts the plan pass, not the wait.
          phases.push({ ids: ['clarification-1'], until: answered - 1 });
        } else {
          phases.push({ ids: ['pm-architect-plan'], until: t });
        }
      } else {
        phases.push({ ids: ['pm-architect'], until: t });
      }
    } else if (step === 'developer' || step === 'qa-tester' || step === 'triage') {
      phases.push({ ids: [`${step}-${attempt}`], until: t });
    } else if (step === 'reviewer' || step === 'security') {
      // Review and security run in parallel and their lines interleave: both own the window.
      const previous = phases[phases.length - 1];
      if (previous && previous.ids.includes('reviewer') && previous.ids.includes('security')) {
        previous.until = Math.max(previous.until, t);
      } else {
        phases.push({ ids: ['reviewer', 'security'], until: t });
      }
    } else {
      phases.push({ ids: [step], until: t });
    }
  }

  return phases.sort((a, b) => a.until - b.until);
}

export interface AttributedLog {
  text: string;
  /** Node ids this line belongs to (review and security share their window). */
  ids: string[];
}

/**
 * Assigns every console line to the pipeline node(s) it belongs to.
 *
 * @param tailIds nodes that own lines newer than the last recorded phase (the running node).
 */
export function attributeLogs(
  lines: string[],
  events: RunEventRecord[],
  hasExchange: boolean,
  tailIds: string[],
): AttributedLog[] {
  const phases = buildPhases(events, hasExchange);
  const result: AttributedLog[] = [];
  let current: string[] = ['prepare-run'];

  for (const text of lines) {
    const factoryMessage = extractFactoryMessage(text);
    // Delivery is not an agent; its own messages are unambiguous whatever the clock says.
    if (factoryMessage?.includes('delivery')) {
      current = ['delivery'];
    } else {
      const t = parseLineTime(text);
      if (t !== null) {
        const phase = phases.find((p) => p.until >= t);
        current = phase ? phase.ids : tailIds.length > 0 ? tailIds : current;
      }
      // Lines without a timestamp (context under a log header, stack frames) stay with
      // whatever owned the line above them.
    }
    result.push({ text, ids: current });
  }

  return result;
}
