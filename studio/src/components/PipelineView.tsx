import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActivityEntry,
  DeliveryEdits,
  FactoryRun,
  PendingInput,
  PipelineConfig,
  RunArtifact,
  RunEventRecord,
} from '../../shared/types';
import {
  artifactForNode,
  attributeLogs,
  derivePipeline,
  type NodeStatus,
  type PipelineNode,
} from '../../shared/pipelineState';
import { titleFromTask } from '../lib/runTitle';
import { AgentDetail } from './AgentDetail';
import { HumanInputPanel } from './HumanInputPanel';
import { WorkingCopyBar, WorkingCopyPreparing } from './WorkingCopy';
import { ModelChip, ModelsSummary } from './ModelChip';
import { UsageLimitRetry } from './UsageLimitRetry';
import { RunTitle } from './RunTitle';
import { clockTime } from '../../shared/usageLimit';
import { activityForNode, currentActivity } from '../../shared/activity';

/** Turn raw factory errors into a friendlier, actionable message. */
function humanizeError(raw: string): string {
  const msg = raw.trim();

  if (/has uncommitted changes/i.test(msg)) {
    return (
      'The target repository has uncommitted changes.\n\n' +
      'The factory needs a clean git baseline so it can produce a reviewable diff. ' +
      'Commit or stash your changes in the repository, then run the task again.'
    );
  }

  if (/session limit|usage limit|rate.?limit/i.test(msg)) {
    return (
      'Claude subscription usage limit reached.\n\n' +
      'You are still signed in — you have simply used up your quota for the current window. ' +
      'Wait for the limit to reset (the message usually says when, e.g. "resets 10:10pm"), ' +
      'then press "Retry run" to continue from where it stopped — the plan and any finished ' +
      'steps are kept. (When the factory knows the reset time, the Studio retries by itself then: ' +
      'see "Retry automatically" in Settings.)'
    );
  }

  if (/No runnable verification configured/i.test(msg)) {
    return (
      'No test command could be detected for this repository.\n\n' +
      'Add a known build manifest (package.json, pom.xml, go.mod, ...) at the repo root or a ' +
      'subproject, or pass an explicit test command in Settings.'
    );
  }

  // Handle validation errors from input schema
  if (/Invalid input data/i.test(msg)) {
    const cleanMsg = msg
      .replace(/Invalid input data:\s*/i, '')
      .replace(/^-\s*/gm, '• ')
      .replace(/Too small: expected string to have >=(\d+) characters/g, 
               'Must be at least $1 characters long')
      .replace(/Too large: expected string to have <=(\d+) characters/g, 
               'Must be at most $1 characters long')
      .trim();
    
    return (
      'Invalid input provided:\n\n' +
      cleanMsg +
      '\n\nPlease fix the input and try again.'
    );
  }

  return msg;
}

const ALL_STAGES: PipelineConfig = { qa: true, review: true, security: true, documentation: true, polish: true };

/** How often a live (or waiting) run is re-read from disk. */
const POLL_MS = 2000;
const MAX_OUTPUT_LINES = 3000;

interface PipelineViewProps {
  runId: string | null;
  /** The caller's belief that the run is live - only used until the run's real state is read. */
  isRunning: boolean;
  onClose?: () => void;
  onRetry?: (runId: string) => void;
  /** The run's name changed (the AI named it, or the user renamed it): the history shows the new one. */
  onTitleChanged?: (runId: string, title: string, source?: FactoryRun['titleSource']) => void;
  /** Open another run - used to move between the rounds of one task. */
  onOpenRun?: (runId: string) => void;
  /** The stage selection of the task form; used only before the run records its own. */
  pipelineConfig?: PipelineConfig;
}

/* -------------------------------------------------------------------------- */
/* Pipeline strip                                                              */
/* -------------------------------------------------------------------------- */

const isFinished = (status: NodeStatus) => status === 'completed' || status === 'skipped';

function PipelineStrip({
  nodes,
  selectedId,
  onSelect,
  artifacts = [],
}: {
  nodes: PipelineNode[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  artifacts?: RunArtifact[];
}) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg p-6 overflow-x-auto">
      <div
        className="flex items-center justify-between"
        style={{ minWidth: Math.max(800, nodes.length * 96) }}
      >
        {nodes.map((node, index) => (
          <div key={node.id} className="flex items-center">
            <button
              onClick={() => onSelect(selectedId === node.id ? null : node.id)}
              title={node.activity ?? node.name}
              className={`relative flex flex-col items-center group transition-all duration-300 ${
                selectedId === node.id ? 'scale-110' : 'hover:scale-105'
              }`}
            >
              <div
                className={`relative w-16 h-16 rounded-full flex items-center justify-center text-2xl transition-all duration-300 shadow-lg ${
                  node.status === 'running'
                    ? 'bg-blue-500 ring-4 ring-blue-400/50 animate-pulse'
                    : node.status === 'waiting'
                      ? 'bg-amber-500 ring-4 ring-amber-400/50 animate-pulse'
                      : node.status === 'completed'
                        ? 'bg-green-500'
                        : node.status === 'failed'
                          ? 'bg-red-500'
                          : node.status === 'retry'
                            ? 'bg-yellow-500'
                            : node.status === 'skipped'
                              ? 'bg-amber-400/60 dark:bg-amber-500/40'
                              : 'bg-slate-300 dark:bg-slate-600'
                } ${selectedId === node.id ? 'ring-4 ring-indigo-400' : ''}`}
              >
                {node.status === 'running' && (
                  <div className="absolute inset-0 rounded-full bg-blue-400 animate-ping opacity-75"></div>
                )}
                {node.status === 'completed' ? (
                  <span className="relative text-white text-xl">✓</span>
                ) : node.status === 'failed' ? (
                  <span className="relative text-white text-xl">✗</span>
                ) : node.status === 'retry' ? (
                  <span className="relative text-white text-xl">↻</span>
                ) : node.status === 'waiting' ? (
                  <span className="relative text-white text-xl">⏸</span>
                ) : node.status === 'skipped' ? (
                  <span className="relative text-amber-900 dark:text-amber-200 text-xl">⊘</span>
                ) : (
                  <span className={`relative ${node.status === 'running' ? 'animate-bounce' : ''}`}>
                    {node.icon}
                  </span>
                )}
              </div>

              <span
                className={`mt-2 text-sm font-medium whitespace-nowrap ${
                  node.status === 'running'
                    ? 'text-blue-600 dark:text-blue-400'
                    : node.status === 'waiting'
                      ? 'text-amber-600 dark:text-amber-400'
                      : node.status === 'failed'
                        ? 'text-red-600 dark:text-red-400'
                        : node.status === 'skipped'
                          ? 'text-amber-600 dark:text-amber-400'
                          : node.status === 'completed'
                            ? 'text-green-600 dark:text-green-400'
                            : node.status === 'retry'
                              ? 'text-yellow-600 dark:text-yellow-400'
                              : 'text-slate-500'
                }`}
              >
                {node.name}
              </span>

              <span className="mt-1 h-5">
                <ModelChip artifact={artifactForNode(node, artifacts)} compact />
              </span>

              {node.status === 'running' && (
                <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 flex space-x-1">
                  <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                  <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                  <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                </div>
              )}
            </button>

            {index < nodes.length - 1 && (
              <div className="flex items-center mx-2">
                <div
                  className={`h-1 w-8 transition-colors duration-300 ${
                    isFinished(node.status) ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'
                  }`}
                ></div>
                <div
                  className={`w-0 h-0 border-t-[6px] border-t-transparent border-b-[6px] border-b-transparent border-l-[8px] transition-colors duration-300 ${
                    isFinished(node.status) ? 'border-l-green-400' : 'border-l-slate-300 dark:border-l-slate-600'
                  }`}
                ></div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Header copy                                                                 */
/* -------------------------------------------------------------------------- */

const WAITING_COPY: Record<string, { title: string; subtitle: string }> = {
  CLARIFICATION_REQUIRED: {
    title: 'Factory Needs Your Answers',
    subtitle: 'The architect asked a few questions before planning',
  },
  DELIVERY_APPROVAL_REQUIRED: {
    title: 'Factory Waiting for Approval',
    subtitle: 'Review and approve the delivery',
  },
  ESCALATION_REQUIRED: {
    title: 'Factory Needs Your Decision',
    subtitle: 'The factory could not resolve this on its own',
  },
};

function describeOutcome(
  status: string | undefined,
  isRound = false,
): { title: string; subtitle: string; tone: 'green' | 'amber' } {
  switch (status) {
    case 'DELIVERED':
    case 'DELIVERED_WITH_PR':
      return {
        title: 'Factory Complete',
        subtitle: isRound ? 'Pull request updated with the requested changes' : 'Pull request opened',
        tone: 'green',
      };
    case 'DELIVERED_WITHOUT_PR':
      return { title: 'Factory Complete', subtitle: 'Delivered without a pull request', tone: 'green' };
    case 'ESCALATED_TO_HUMAN':
      return { title: 'Escalated to a Human', subtitle: 'Resolved by a human decision', tone: 'amber' };
    case 'ABORTED_BY_HUMAN':
      return { title: 'Run Aborted', subtitle: 'Stopped by a human decision', tone: 'amber' };
    case 'BLOCKED':
      return { title: 'Run Blocked', subtitle: 'A gate blocked the delivery', tone: 'amber' };
    default:
      return { title: 'Factory Complete', subtitle: 'Multi-agent pipeline', tone: 'green' };
  }
}

/* -------------------------------------------------------------------------- */
/* View                                                                        */
/* -------------------------------------------------------------------------- */

export function PipelineView({ runId, isRunning, onClose, onRetry, onOpenRun, onTitleChanged, pipelineConfig }: PipelineViewProps) {
  const [runInfo, setRunInfo] = useState<FactoryRun | null>(null);
  /** Every round of this task (the run itself and each revision of it), oldest first. */
  const [rounds, setRounds] = useState<Array<{ runId: string; round: number; status: string; kind: string }>>([]);
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
  const [events, setEvents] = useState<RunEventRecord[]>([]);
  const [pendingInput, setPendingInput] = useState<PendingInput | null>(null);
  const [outputLines, setOutputLines] = useState<string[]>([]);
  /** What the agents did, live (`activity.ndjson`), read incrementally like the output. */
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const activityCursor = useRef<number | undefined>(undefined);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [submittingInput, setSubmittingInput] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** After "Retry run" the process takes a moment to spawn; until then the disk still says FAILED. */
  const [retryGraceUntil, setRetryGraceUntil] = useState(0);
  const wasRunning = useRef(isRunning);

  const activeRunRef = useRef<string | null>(runId);
  /** Number of output lines already received; the next read asks only for what follows. */
  const outputCursor = useRef<number | undefined>(undefined);
  /** A gate the user just answered. The CLI removes its file a moment later; hide it meanwhile. */
  const submittedRef = useRef<{ reason: string; until: number } | null>(null);
  const lastAutoSelectedRef = useRef<string | null>(null);
  const inFlight = useRef(false);
  const queued = useRef(false);

  // A different run: drop everything that belonged to the previous one.
  useEffect(() => {
    activeRunRef.current = runId;
    setRunInfo(null);
    setRounds([]);
    setArtifacts([]);
    setEvents([]);
    setPendingInput(null);
    setOutputLines([]);
    setActivity([]);
    activityCursor.current = undefined;
    setSelectedAgent(null);
    setSubmittingInput(false);
    outputCursor.current = undefined;
    submittedRef.current = null;
    lastAutoSelectedRef.current = null;
  }, [runId]);

  /**
   * Reads everything the run has persisted. This is the single source of truth for the view:
   * a mount after a repository switch, a finished run opened from history and a live run all
   * read the same files, so the pipeline looks the same however the user got here.
   */
  const loadOnce = useCallback(async () => {
    const id = runId;
    if (!id) return;
    try {
      const [run, arts, evs, pending, out] = await Promise.all([
        window.api.invoke('factory:get', id),
        window.api.invoke('factory:get-artifacts', id),
        window.api.invoke('factory:get-events', id),
        window.api.invoke('factory:get-pending-input', id),
        window.api.invoke('factory:get-output', id, outputCursor.current),
      ]);
      if (activeRunRef.current !== id) return; // the user moved on while this was in flight

      setRunInfo(run);
      setArtifacts(arts);
      setEvents(evs);

      let effectivePending = pending;
      const submitted = submittedRef.current;
      if (pending && submitted && pending.reason === submitted.reason && Date.now() < submitted.until) {
        effectivePending = null;
      } else if (!pending) {
        submittedRef.current = null;
      }
      setPendingInput(effectivePending);
      if (effectivePending) setSubmittingInput(false);

      if (outputCursor.current === undefined) {
        setOutputLines(out.lines.slice(-MAX_OUTPUT_LINES));
      } else if (out.lines.length > 0) {
        setOutputLines((prev) => [...prev, ...out.lines].slice(-MAX_OUTPUT_LINES));
      }
      outputCursor.current = out.total;
    } catch {
      // Transient (file mid-write, run just created): the next poll retries.
    }
    // Read on its own: a run without activity (or a main process that predates it) must not stop the rest.
    try {
      const act = await window.api.invoke('factory:get-activity', id, activityCursor.current);
      if (activeRunRef.current !== id) return;
      if (activityCursor.current === undefined) setActivity(act.entries);
      else if (act.entries.length > 0) setActivity((prev) => [...prev, ...act.entries]);
      activityCursor.current = act.total;
    } catch {
      // No activity to show: the step views fall back to the console lines.
    }
  }, [runId]);

  /** Serialises reads so two overlapping refreshes cannot append the same output twice. */
  const refresh = useCallback(async () => {
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        queued.current = false;
        await loadOnce();
      } while (queued.current);
    } finally {
      inFlight.current = false;
    }
  }, [loadOnce]);

  useEffect(() => {
    if (isRunning && !wasRunning.current) setRetryGraceUntil(Date.now() + 15_000);
    wasRunning.current = isRunning;
  }, [isRunning]);

  /** Why the AI could not name the run, when the run was named from its request instead. */
  const namerError = useMemo(() => {
    const data = artifacts.find((a) => a.step === 'run-namer' && a.status === 'FALLBACK')?.data;
    return typeof data?.error === 'string' ? data.error.replace(/^Agent "run-namer" failed during step "run-namer"\s*/, '') : undefined;
  }, [artifacts]);

  // The AI names the task a few seconds into the run: the history is told, so it shows the name too.
  // The callback is kept in a ref: the parent passes a new function on every render, and the effect must run
  // only when the name changes.
  const runTitle = runInfo?.title;
  const runTitleSource = runInfo?.titleSource;
  const titleChanged = useRef(onTitleChanged);
  titleChanged.current = onTitleChanged;
  useEffect(() => {
    if (runId && runTitle) titleChanged.current?.(runId, runTitle, runTitleSource);
  }, [runId, runTitle, runTitleSource]);

  /** Renames the run (double-click on its name): saved with the run, then read back. */
  const renameRun = useCallback(
    async (title: string) => {
      if (!runId) return;
      await window.api.invoke('factory:rename-run', runId, title);
      await refresh();
    },
    [runId, refresh],
  );

  /* ---- derived pipeline ---- */
  // The run's own recorded stages win; before it has any, show what the task form selected.
  const effectivePipeline = useMemo<PipelineConfig>(
    () => runInfo?.pipeline ?? (runInfo ? ALL_STAGES : (pipelineConfig ?? ALL_STAGES)),
    [runInfo, pipelineConfig],
  );

  // Just (re)started by the user but the backend has not caught up: trust the user, not the disk.
  const starting = isRunning && now < retryGraceUntil && runInfo?.status !== 'RUNNING';

  const derived = useMemo(
    () =>
      derivePipeline({
        artifacts,
        events,
        pendingInput,
        runStatus: starting ? null : (runInfo?.status ?? null),
        assumeAlive: isRunning,
        pipeline: effectivePipeline,
        failedStep: starting ? undefined : runInfo?.failedStep,
      }),
    [artifacts, events, pendingInput, runInfo, isRunning, starting, effectivePipeline],
  );

  // Which rounds this task has. Not part of the polling: it scans the log directory, and the answer
  // only changes when a round is added or this run changes state.
  useEffect(() => {
    const id = runId;
    if (!id) return;
    let cancelled = false;
    window.api
      .invoke('factory:get-rounds', id)
      .then((list) => {
        if (!cancelled) setRounds(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [runId, derived.lifecycle]);

  /* ---- keep it fresh ---- */
  const shouldPoll =
    (runInfo === null && isRunning) ||
    starting ||
    derived.lifecycle === 'running' ||
    derived.lifecycle === 'waiting';

  useEffect(() => {
    if (!runId) return;
    void refresh();
    if (!shouldPoll) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [runId, shouldPoll, refresh]);

  // Output and completion events only *nudge* a refresh: the state itself is read from disk.
  useEffect(() => {
    if (!runId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const nudge = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, 400);
    };
    const offOutput = window.api.on('factory:output', (id: string) => {
      if (id === runId) nudge();
    });
    const offDone = window.api.on('factory:completed', (id: string) => {
      if (id === runId) void refresh();
    });
    const offError = window.api.on('factory:error', (id: string) => {
      if (id === runId) void refresh();
    });
    return () => {
      offOutput();
      offDone();
      offError();
      if (timer) clearTimeout(timer);
    };
  }, [runId, refresh]);

  /* ---- elapsed time ---- */
  useEffect(() => {
    if (derived.lifecycle !== 'running' && !starting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [derived.lifecycle, starting]);

  const elapsedSeconds = useMemo(() => {
    if (!runInfo?.startedAt) return 0;
    const start = new Date(runInfo.startedAt).getTime();
    const lastEvent = events[events.length - 1]?.at;
    const end =
      derived.lifecycle === 'running'
        ? now
        : new Date(runInfo.finishedAt ?? lastEvent ?? now).getTime();
    return Math.max(0, Math.floor((end - start) / 1000));
  }, [runInfo, events, derived.lifecycle, now]);

  /* ---- selection ---- */
  const waitingNodeId = derived.nodes.find((n) => n.status === 'waiting')?.id ?? null;
  const focusId = derived.runningIds[0] ?? waitingNodeId ?? derived.failedNodeId;

  // Follow the step that is running / waiting / failed - but only when it CHANGES, so the user
  // can still click around without being dragged back.
  useEffect(() => {
    if (focusId && lastAutoSelectedRef.current !== focusId) {
      lastAutoSelectedRef.current = focusId;
      setSelectedAgent(focusId);
    }
  }, [focusId]);

  const handleSubmitInput = useCallback(
    async (answer: {
      clarifications?: string;
      decision?: 'ACKNOWLEDGE' | 'ABORT';
      guidance?: string;
      approvePush?: boolean;
      approvePullRequest?: boolean;
      edits?: DeliveryEdits;
    }) => {
      if (!runId || !pendingInput) return;
      setSubmittingInput(true);
      try {
        submittedRef.current = { reason: pendingInput.reason, until: Date.now() + 10_000 };
        await window.api.invoke('factory:submit-input', { runId, ...answer });
        setPendingInput(null);
        void refresh();
      } catch (error) {
        console.error('Failed to submit input:', error);
        submittedRef.current = null;
        setSubmittingInput(false);
      }
    },
    [runId, pendingInput, refresh],
  );

  /* ---- logs per step ---- */
  const tailIds = useMemo(() => {
    if (derived.runningIds.length > 0) return derived.runningIds;
    return focusId ? [focusId] : [];
  }, [derived.runningIds, focusId]);

  const attributedLogs = useMemo(
    () => attributeLogs(outputLines, events, derived.exchanges.length > 0, tailIds),
    [outputLines, events, derived.exchanges.length, tailIds],
  );

  /* ---- render ---- */
  // Run just started: its directory does not exist yet. Show the planned pipeline, pulsing.
  if (!runId && isRunning) {
    const skeleton = derivePipeline({
      artifacts: [],
      events: [],
      pendingInput: null,
      runStatus: null,
      assumeAlive: true,
      pipeline: pipelineConfig ?? ALL_STAGES,
    });
    return (
      <div className="space-y-4">
        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-lg p-6 text-white">
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="w-12 h-12 border-4 border-white/30 border-t-white rounded-full animate-spin"></div>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-5 h-5 bg-white rounded-full animate-pulse"></div>
              </div>
            </div>
            <div>
              <h3 className="font-bold text-xl">Starting Factory...</h3>
              <p className="text-sm text-white/80">Initializing multi-agent pipeline</p>
            </div>
          </div>
        </div>
        <PipelineStrip nodes={skeleton.nodes} selectedId={null} onSelect={() => {}} />
      </div>
    );
  }

  if (!runId) return null;

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const { lifecycle } = derived;
  const isRound = runInfo?.kind === 'revision';
  const outcome = describeOutcome(runInfo?.status, isRound);
  const waitingCopy = (pendingInput && WAITING_COPY[pendingInput.reason]) || {
    title: 'Factory Waiting for Input',
    subtitle: 'The run is paused',
  };
  const failedNode = derived.nodes.find((n) => n.id === derived.failedNodeId);
  // Every step finished and the delivery went through, yet the run has no outcome recorded: a
  // missing closing record, not a failure. Saying "Failed" in red there is what made a successful
  // run - pull request and all - look broken.
  const notClosedOut =
    lifecycle === 'failed' &&
    !failedNode &&
    derived.nodes.find((n) => n.id === 'delivery')?.status === 'completed';

  // Stopped on Claude's usage limit with a retry planned: not over, just waiting for the limit.
  const waitingForLimit = lifecycle === 'failed' && !notClosedOut && runInfo?.autoRetry?.status === 'scheduled' && !!runInfo.usageLimit;

  const headerTone =
    lifecycle === 'waiting' || waitingForLimit
      ? 'bg-gradient-to-r from-amber-600 to-orange-600'
      : lifecycle === 'running'
        ? 'bg-gradient-to-r from-blue-600 to-indigo-600'
        : lifecycle === 'failed'
          ? notClosedOut
            ? 'bg-gradient-to-r from-amber-600 to-orange-600'
            : 'bg-gradient-to-r from-red-600 to-rose-600'
          : outcome.tone === 'amber'
            ? 'bg-gradient-to-r from-amber-600 to-orange-600'
            : 'bg-gradient-to-r from-green-600 to-emerald-600';

  const headerTitle =
    lifecycle === 'waiting'
      ? waitingCopy.title
      : lifecycle === 'running'
        ? 'Factory Running'
        : lifecycle === 'failed'
          ? notClosedOut
            ? 'Run Not Closed Out'
            : waitingForLimit
              ? "Waiting for Claude's Usage Limit"
              : 'Factory Failed'
          : outcome.title;

  const headerSubtitle =
    lifecycle === 'waiting'
      ? waitingCopy.subtitle
      : lifecycle === 'failed'
        ? notClosedOut
          ? 'The delivery finished - only the final record is missing'
          : waitingForLimit
            ? `Stopped${failedNode ? ` at ${failedNode.name}` : ''}; it continues by itself at ${clockTime(runInfo!.autoRetry!.retryAt, Date.now())}`
            : failedNode
            ? `Stopped at ${failedNode.name}`
            : 'The run did not finish'
        : lifecycle === 'running'
          ? derived.attempt > 1
            ? `Attempt ${derived.attempt}`
            : isRound
              ? `Round ${runInfo?.round ?? 2} - addressing review comments`
              : 'Multi-agent pipeline'
          : outcome.subtitle;

  /** The run has finished preparing: its record says where it works. */
  const prepared = events.some((event) => event.type === 'step_completed' && event.step === 'prepare-run');

  const selectedNode = derived.nodes.find((n) => n.id === selectedAgent) ?? null;
  const selectedLogs = selectedNode
    ? attributedLogs.filter((l) => l.ids.includes(selectedNode.id)).map((l) => l.text)
    : [];
  const runningNodes = derived.nodes.filter((n) => n.status === 'running');

  return (
    <div className="space-y-4">
      {/* Where you are, and the way back. Always there: a run keeps going in the background, so leaving
          its screen is never a reason to wait for it to finish. */}
      {onClose && (
        <nav aria-label="Breadcrumb" data-testid="run-breadcrumb" className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <button
            onClick={onClose}
            title="Back to the run history. A run that is still going carries on."
            className="inline-flex items-center gap-1 px-2 py-1 -ml-2 rounded-md font-medium hover:bg-slate-200/70 dark:hover:bg-slate-700/60 transition-colors"
          >
            <span aria-hidden="true">←</span> Run history
          </button>
          <span aria-hidden="true" className="text-slate-400">/</span>
          {runInfo ? (
            <RunTitle
              title={runInfo.title ?? titleFromTask(runInfo.task)}
              source={runInfo.titleSource}
              why={namerError}
              task={runInfo.task}
              onRename={renameRun}
            />
          ) : (
            <span className="font-medium text-slate-900 dark:text-slate-100">Run</span>
          )}
          {runInfo?.taskId && (
            <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700">{runInfo.taskId}</span>
          )}
          {isRound && (
            <span className="text-xs font-medium text-indigo-700 dark:text-indigo-300">Round {runInfo?.round}</span>
          )}
        </nav>
      )}

      {/* Header with timer */}
      <div className={`rounded-lg p-4 text-white ${headerTone}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {lifecycle === 'running' && (
              <div className="relative">
                <div className="w-10 h-10 border-4 border-white/30 border-t-white rounded-full animate-spin"></div>
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-4 h-4 bg-white rounded-full animate-pulse"></div>
                </div>
              </div>
            )}
            {lifecycle === 'waiting' && <div className="text-3xl">⏸</div>}
            {lifecycle === 'failed' && <div className="text-4xl">{notClosedOut ? '!' : '✗'}</div>}
            {lifecycle === 'done' && (
              <div className="text-4xl">{outcome.tone === 'amber' ? '!' : '✓'}</div>
            )}
            <div>
              <h3 className="font-bold text-lg">{headerTitle}</h3>
              <p className="text-sm text-white/80">{headerSubtitle}</p>
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-mono font-bold">{formatTime(elapsedSeconds)}</div>
            <div className="text-sm text-white/70">{runId}</div>
          </div>
        </div>
      </div>

      {/* Where the work is: the folder and the branch, so the user can look at the code by hand. Only once the
          run has said so: until its preparation is done the record cannot tell (and would say "your
          repository"), and a run that failed before that never worked anywhere. */}
      {runId && runInfo && prepared && (
        <WorkingCopyBar runId={runId} refreshKey={`${runInfo.status}:${runInfo.round ?? 1}`} />
      )}
      {runId && runInfo && !prepared && derived.lifecycle === 'running' && <WorkingCopyPreparing />}

      {/* The rounds of this task: one task, several rounds, each with its own results */}
      {(rounds.length > 1 || isRound) && (
        <nav
          aria-label="Rounds of this task"
          data-testid="rounds-nav"
          className="flex flex-wrap items-center gap-2 rounded-lg bg-white dark:bg-slate-800 px-4 py-2 text-sm"
        >
          <span className="text-slate-500 dark:text-slate-400">
            {runInfo?.pullRequest ? `Pull request #${runInfo.pullRequest.number}` : 'This task'}:
          </span>
          {rounds.map((entry) => {
            const current = entry.runId === runId;
            return (
              <button
                key={entry.runId}
                disabled={current || !onOpenRun}
                onClick={() => onOpenRun?.(entry.runId)}
                aria-current={current ? 'true' : undefined}
                title={entry.runId}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  current
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-600 disabled:hover:bg-slate-100'
                }`}
              >
                Round {entry.round}
                {entry.status === 'RUNNING' && ' ●'}
                {entry.status === 'FAILED' && ' ✗'}
              </button>
            );
          })}
          {isRound && runInfo?.parentRunId && (
            <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
              continues <span className="font-mono">{runInfo.parentRunId}</span>
            </span>
          )}
        </nav>
      )}

      {/* Why the run failed: always shown for a failed run, with the real reason */}
      {lifecycle === 'failed' && (
        <div
          className={`border-2 rounded-lg p-4 shadow-md ${
            notClosedOut
              ? 'border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20'
              : 'border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-900/20'
          }`}
        >
          <div className="flex items-start gap-3">
            <span className="text-2xl">{notClosedOut ? 'ℹ️' : '⚠️'}</span>
            <div className="flex-1">
              <h3
                className={`text-base font-bold mb-2 ${
                  notClosedOut ? 'text-amber-800 dark:text-amber-200' : 'text-red-700 dark:text-red-300'
                }`}
              >
                {notClosedOut
                  ? 'Run Not Closed Out'
                  : runInfo?.usageLimit
                    ? `Stopped${failedNode ? ` at ${failedNode.name}` : ''}: Claude Usage Limit Reached`
                    : `Run Failed${failedNode ? ` at ${failedNode.name}` : ''}`}
              </h3>
              {runInfo?.usageLimit && !notClosedOut ? (
                // Stopped on Claude's usage limit: when it resets, and the automatic retry.
                <UsageLimitRetry
                  run={runInfo}
                  {...(onRetry ? { onRetryNow: () => onRetry(runId) } : {})}
                  onChanged={() => void refresh()}
                />
              ) : (
              <>
              <p
                className={`text-sm whitespace-pre-wrap break-words leading-relaxed mb-3 ${
                  notClosedOut ? 'text-amber-900 dark:text-amber-100' : 'text-red-900 dark:text-red-100'
                }`}
              >
                {humanizeError(runInfo?.error ?? 'The run failed without recording a reason.')}
              </p>
              {onRetry && (
                <button
                  onClick={() => onRetry(runId)}
                  className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
                >
                  {notClosedOut ? '✓ Close out run' : '▶ Retry Run'}
                </button>
              )}
              </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Human-in-the-loop gate: the pipeline is paused until this is answered */}
      {pendingInput && (
        <HumanInputPanel input={pendingInput} onSubmit={handleSubmitInput} submitting={submittingInput} />
      )}

      <PipelineStrip nodes={derived.nodes} selectedId={selectedAgent} onSelect={setSelectedAgent} artifacts={artifacts} />
      <ModelsSummary artifacts={artifacts} />

      {/* What is happening right now (review and security can run side by side) */}
      {runningNodes.map((node) => (
        <div key={node.id} className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-lg p-4 text-white">
          <div className="flex items-center gap-3">
            <div className="text-4xl animate-pulse">{node.icon}</div>
            <div className="flex-1">
              <h4 className="font-bold text-lg">{node.name}</h4>
              <p className="text-sm text-white/80">{node.activity || 'Processing...'}</p>
              {(() => {
                // The newest thing the step's agent did: a file it reads, a search, what it is saying.
                const now = currentActivity(activityForNode(activity, node));
                return now ? (
                  <p data-testid="now-doing" className="mt-1 text-sm text-white font-medium break-words">
                    {now}
                  </p>
                ) : null;
              })()}
            </div>
            <button
              onClick={() => setSelectedAgent(node.id)}
              className="flex-shrink-0 self-start rounded bg-white/15 px-2 py-1 text-xs hover:bg-white/25"
            >
              Follow live
            </button>
          </div>
        </div>
      ))}

      {/* Selected step report */}
      {selectedNode && (
        <div className="bg-slate-900 rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xl">{selectedNode.icon}</span>
              <span className="text-sm font-semibold text-slate-100">{selectedNode.name} Report</span>
            </div>
            <button onClick={() => setSelectedAgent(null)} className="text-xs text-slate-400 hover:text-white">
              Close
            </button>
          </div>
          <div className="p-4">
            <AgentDetail
              step={selectedNode.id}
              node={selectedNode}
              artifact={artifactForNode(selectedNode, artifacts)}
              logs={selectedLogs}
              activity={activityForNode(activity, selectedNode)}
              isRunning={selectedNode.status === 'running'}
              error={selectedNode.id === derived.failedNodeId ? (runInfo?.error ?? null) : null}
              exchange={derived.exchanges[0]}
              events={events}
              pendingInput={pendingInput}
            />
          </div>
        </div>
      )}

      {/* Technical logs - only when no step is selected (general overview) */}
      {!selectedAgent && lifecycle === 'running' && outputLines.length > 0 && (
        <div className="bg-slate-900 rounded-lg overflow-hidden">
          <div className="w-full px-4 py-2 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-200">Live Output</span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-600 text-white">
                <span className="w-2 h-2 bg-white rounded-full animate-pulse"></span>
                Live
              </span>
            </div>
          </div>
          <div className="p-4 max-h-48 overflow-y-auto font-mono text-xs text-slate-300 space-y-1">
            {outputLines.slice(-30).map((line, index) => (
              <div key={index} className="hover:bg-slate-800 px-1 rounded">
                {line}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
