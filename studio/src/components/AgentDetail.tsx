import type { ActivityEntry, PendingInput, RunArtifact, RunEventRecord } from '../../shared/types';
import type { HumanExchange, PipelineNode } from '../../shared/pipelineState';
import { formatDuration } from '../lib/format';
import { ModelChip, RoutingPanel } from './ModelChip';
import { ActivityFeed } from './ActivityFeed';

interface AgentDetailProps {
  /** Node id (`developer-2`, `reviewer`, `clarification-1`, ...). */
  step: string;
  node?: PipelineNode;
  artifact?: RunArtifact;
  /** Console lines attributed to this step. */
  logs?: string[];
  isRunning?: boolean;
  /** Why this step failed, when it did. */
  error?: string | null;
  /** The architect's question and the human's answer (clarification steps). */
  exchange?: HumanExchange;
  /** The run's audit trail - the delivery step is described from it while it has no report. */
  events?: RunEventRecord[];
  pendingInput?: PendingInput | null;
  /** What the step's agent calls did, live (`activity.ndjson`). */
  activity?: ActivityEntry[];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">{title}</h5>
      {children}
    </div>
  );
}

function Pill({ children, tone = 'slate' }: { children: React.ReactNode; tone?: string }) {
  const tones: Record<string, string> = {
    green: 'bg-green-500/15 text-green-300 border-green-500/30',
    red: 'bg-red-500/15 text-red-300 border-red-500/30',
    yellow: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30',
    blue: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
    slate: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border ${tones[tone] || tones.slate}`}>
      {children}
    </span>
  );
}

function FileList({ files }: { files: any[] }) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const changeTone: Record<string, string> = {
    ADDED: 'green',
    MODIFIED: 'blue',
    DELETED: 'red',
  };
  return (
    <ul className="space-y-1">
      {files.map((file, i) => (
        <li key={i} className="flex items-start gap-2 text-xs">
          <Pill tone={changeTone[file.changeType] || 'slate'}>{file.changeType || 'CHANGED'}</Pill>
          <div className="min-w-0">
            <div className="font-mono text-slate-200 break-all">{file.path}</div>
            {file.purpose && <div className="text-slate-400">{file.purpose}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

const timeOf = (iso?: string): string | null => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString();
};

function ErrorBox({ title, message }: { title: string; message: string }) {
  return (
    <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
      <div className="flex items-start gap-2">
        <svg className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-red-300 mb-1">{title}</div>
          <p className="text-xs text-red-200/90 leading-relaxed whitespace-pre-wrap break-words">{message}</p>
        </div>
      </div>
    </div>
  );
}

function LogBox({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="bg-slate-800/50 rounded-lg p-3 max-h-64 overflow-y-auto">
      <pre className="font-mono text-xs text-slate-300 whitespace-pre-wrap break-words">
        {lines.slice(-30).join('\n')}
      </pre>
    </div>
  );
}

/** What the delivery step did, action by action (commit, push, pull request). */
function DeliveryTimeline({
  items,
}: {
  items: Array<{ at?: string; action: string; ok: boolean; detail: string }>;
}) {
  if (items.length === 0) return null;
  const label: Record<string, string> = {
    commit: 'Commit',
    push: 'Push',
    'pull-request': 'Pull request',
    error: 'Error',
  };
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li
          key={i}
          className={`flex items-start gap-2 text-sm rounded p-2 ${
            item.ok ? 'bg-green-500/10 text-green-200' : 'bg-red-500/10 text-red-200'
          }`}
        >
          <span className="flex-shrink-0">{item.ok ? '✓' : '✗'}</span>
          <div className="min-w-0 flex-1">
            <span className="font-semibold">{label[item.action] ?? item.action}</span>
            <span className="text-slate-400"> — </span>
            <span className="break-words">{item.detail}</span>
          </div>
          {timeOf(item.at) && <span className="text-xs text-slate-500 flex-shrink-0">{timeOf(item.at)}</span>}
        </li>
      ))}
    </ul>
  );
}

/** A step that has no report (yet): say what state it is in instead of one generic message. */
function PendingStep({
  base,
  node,
  logs,
  isRunning,
  error,
  events,
  pendingInput,
  activity,
}: {
  base: string;
  node?: PipelineNode;
  logs?: string[];
  isRunning?: boolean;
  error?: string | null;
  events?: RunEventRecord[];
  pendingInput?: PendingInput | null;
  activity?: ActivityEntry[];
}) {
  const status = node?.status ?? (isRunning ? 'running' : 'pending');
  const lines = logs ?? [];
  const live = activity ?? [];

  const deliveryActions =
    base === 'delivery'
      ? (events ?? [])
          .filter((e) => e.type === 'delivery_action')
          .map((e) => ({
            at: e.at,
            action: String(e.action ?? ''),
            ok: e.ok === true,
            detail: String(e.detail ?? ''),
          }))
      : [];

  const proposal = base === 'delivery' && pendingInput?.reason === 'DELIVERY_APPROVAL_REQUIRED' ? pendingInput : null;

  return (
    <div className="space-y-3">
      {status === 'failed' && (
        <ErrorBox title="Step failed" message={error ?? 'This step did not finish and no reason was recorded.'} />
      )}

      {status === 'waiting' && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-sm text-amber-200">
          ⏸ {node?.activity ?? 'Waiting for your input'}. Use the form above to continue.
        </div>
      )}

      {status === 'skipped' && (
        <div className="bg-slate-500/10 border border-slate-500/30 rounded-lg p-3 text-sm text-slate-300">
          ⊘ Skipped —{' '}
          {node?.disabled
            ? 'this stage was switched off for this task.'
            : 'there was nothing for this step to do.'}
        </div>
      )}

      {status === 'pending' && <p className="text-sm text-slate-400 italic">Not started yet.</p>}

      {status === 'running' && (
        <div className="flex items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 text-xs">
            <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse"></span>
            Working...
          </span>
          {node?.activity && <span className="text-slate-300">{node.activity}</span>}
        </div>
      )}

      {proposal && (
        <Section title="Proposed delivery">
          <dl className="text-sm text-slate-300 space-y-1 font-mono">
            {proposal.branch && <div><dt className="inline text-slate-500">branch: </dt><dd className="inline">{proposal.branch}</dd></div>}
            {proposal.baseBranch && <div><dt className="inline text-slate-500">base: </dt><dd className="inline">{proposal.baseBranch}</dd></div>}
            {proposal.commitMessage && <div><dt className="inline text-slate-500">commit: </dt><dd className="inline">{proposal.commitMessage}</dd></div>}
            {proposal.pullRequestTitle && <div><dt className="inline text-slate-500">PR title: </dt><dd className="inline">{proposal.pullRequestTitle}</dd></div>}
          </dl>
        </Section>
      )}

      {deliveryActions.length > 0 && (
        <Section title="What delivery has done">
          <DeliveryTimeline items={deliveryActions} />
        </Section>
      )}

      {/* What the agent is doing, live. Runs from before the activity was recorded fall back to the console lines. */}
      {live.length > 0 ? <ActivityFeed entries={live} live={status === 'running'} /> : <LogBox lines={lines} />}
      {status === 'running' && lines.length === 0 && live.length === 0 && deliveryActions.length === 0 && (
        <p className="text-sm text-slate-400 italic">Waiting for output...</p>
      )}
    </div>
  );
}

function QuestionList({ questions }: { questions: string[] }) {
  if (questions.length === 0) return <p className="text-sm text-slate-400 italic">No questions were recorded.</p>;
  return (
    <ol className="space-y-2 list-decimal list-inside">
      {questions.map((question, i) => (
        <li key={i} className="text-sm text-slate-200 leading-relaxed">{question}</li>
      ))}
    </ol>
  );
}

/** First pass of the architect: it read the task and asked questions instead of planning. */
function PmQuestionsView({ exchange }: { exchange?: HumanExchange }) {
  if (!exchange) return <p className="text-sm text-slate-400 italic">No clarification was requested.</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="yellow">Needed clarification</Pill>
        <Pill tone="slate">{exchange.questions.length} question{exchange.questions.length === 1 ? '' : 's'}</Pill>
        {timeOf(exchange.askedAt) && <Pill tone="slate">{timeOf(exchange.askedAt)}</Pill>}
      </div>
      <p className="text-sm text-slate-300 leading-relaxed">
        The task was too ambiguous to plan safely, so the architect stopped and asked before
        writing any code.
      </p>
      {exchange.planSummary && (
        <Section title="First reading of the task">
          <p className="text-sm text-slate-200 leading-relaxed">{exchange.planSummary}</p>
        </Section>
      )}
      <Section title="Questions asked">
        <QuestionList questions={exchange.questions} />
      </Section>
      <p className="text-xs text-slate-500">
        Your answer is in the next step (Clarification); the resulting plan is in PM Plan.
      </p>
    </div>
  );
}

/** The human side of the exchange: what was asked and what was answered. */
function ClarificationView({ exchange }: { exchange?: HumanExchange }) {
  if (!exchange) return <p className="text-sm text-slate-400 italic">No clarification was requested.</p>;
  const answered = exchange.answer !== undefined;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {exchange.open ? (
          <Pill tone="yellow">Waiting for your answer</Pill>
        ) : answered ? (
          <Pill tone="green">Answered</Pill>
        ) : (
          <Pill tone="slate">No answer recorded</Pill>
        )}
        {timeOf(exchange.answeredAt) && <Pill tone="slate">answered {timeOf(exchange.answeredAt)}</Pill>}
      </div>
      <Section title="Questions">
        <QuestionList questions={exchange.questions} />
      </Section>
      <Section title="Your answer">
        {answered ? (
          <blockquote className="border-l-2 border-blue-400 pl-3 text-sm text-slate-100 leading-relaxed whitespace-pre-wrap break-words">
            {exchange.answer}
          </blockquote>
        ) : exchange.open ? (
          <p className="text-sm text-amber-300">Use the form above to answer — the run continues as soon as you do.</p>
        ) : (
          <p className="text-sm text-slate-400 italic">No answer was recorded for this run.</p>
        )}
      </Section>
    </div>
  );
}

/** Tone of an artifact status pill. */
function toneForStatus(status: string): string {
  const s = status.toUpperCase();
  if (s.startsWith('SKIPPED') || s === 'NO_CHANGES') return 'slate';
  if (s === 'REUSED') return 'yellow';
  if (/FAIL|BLOCK|REJECT/.test(s)) return 'red';
  if (
    s === 'COMPLETED' || s === 'PASS' || s.startsWith('PASS') || s.startsWith('APPROVED') ||
    s === 'PR_CREATED' || s === 'PR_UPDATED' || s === 'PUSHED'
  ) {
    return 'green';
  }
  return 'yellow';
}

export function AgentDetail({
  step,
  node,
  artifact,
  logs,
  isRunning,
  error,
  exchange,
  events,
  pendingInput,
  activity,
}: AgentDetailProps) {
  // Node ids carry the attempt (`developer-2`); the renderers below are keyed by the step name.
  // Matching on the raw id meant the Developer and QA reports never got their own view.
  const base = step.replace(/-\d+$/, '');
  const kind = node?.kind ?? 'step';

  // The human-facing steps are rendered from the question/answer exchange, not from an artifact.
  if (kind === 'pm-questions') return <PmQuestionsView exchange={exchange} />;
  if (kind === 'clarification') return <ClarificationView exchange={exchange} />;

  if (!artifact) {
    return (
      <PendingStep
        base={base}
        node={node}
        logs={logs}
        isRunning={isRunning}
        error={error}
        events={events}
        pendingInput={pendingInput}
        activity={activity}
      />
    );
  }

  const data = artifact.data || {};
  const statusTone = toneForStatus(artifact.status);
  const isSkipped = artifact.status.toUpperCase().startsWith('SKIPPED');

  const isFailed =
    artifact.status === 'FAIL' ||
    artifact.status === 'FAILED' ||
    data.verdict === 'FAIL' ||
    data.verdict === 'BLOCKED';

  const header = (
    <div className="space-y-2">
      {isFailed && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <svg className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <div className="flex-1">
              <div className="text-sm font-semibold text-red-300 mb-1">Step Failed</div>
              {data.summary && (
                <p className="text-xs text-red-200/90 leading-relaxed">{data.summary}</p>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={statusTone as any}>{artifact.status}</Pill>
        {artifact.attempt > 1 && <Pill tone="yellow">Attempt {artifact.attempt}</Pill>}
        <ModelChip artifact={artifact} />
        {!artifact.routing && artifact.model && <Pill tone="slate">{artifact.model}</Pill>}
        {typeof artifact.durationMs === 'number' && (
          <Pill tone="slate">{formatDuration(artifact.durationMs)}</Pill>
        )}
      </div>
      <RoutingPanel routing={artifact.routing} />
      {activity && activity.length > 0 && (
        // The report is the result; this is how the agent got there. Open while the step runs again.
        <details open={isRunning} className="group">
          <summary className="cursor-pointer select-none text-xs text-slate-400 hover:text-slate-200">
            What the agent did ({activity.filter((entry) => entry.kind === 'tool').length} tool calls)
          </summary>
          <div className="mt-2">
            <ActivityFeed entries={activity} live={!!isRunning} />
          </div>
        </details>
      )}
    </div>
  );

  // A stage that did not run: say so plainly instead of rendering an empty report.
  if (isSkipped && ['qa-tester', 'reviewer', 'security', 'documentation'].includes(base)) {
    const switchedOff = typeof data.summary === 'string' && /^Stage disabled for this task/i.test(data.summary);
    return (
      <div className="space-y-3">
        {header}
        <div className="bg-slate-500/10 border border-slate-500/30 rounded-lg p-3">
          <div className="text-sm font-semibold text-slate-200 mb-1">
            ⊘ {switchedOff ? 'Switched off for this task' : 'Nothing to do'}
          </div>
          {data.summary && <p className="text-sm text-slate-300 leading-relaxed">{data.summary}</p>}
        </div>
        {data.recommendation && (
          <Section title="Note">
            <p className="text-sm text-slate-400 leading-relaxed">{data.recommendation}</p>
          </Section>
        )}
      </div>
    );
  }

  // --- Escalation (a human decision closed the loop) ---
  if (base === 'escalation') {
    const rootCause = data.rootCause || {};
    return (
      <div className="space-y-4">
        {header}
        {data.reason && (
          <Section title="Why the factory escalated">
            <p className="text-sm text-slate-200 leading-relaxed">{data.reason}</p>
          </Section>
        )}
        {rootCause.explanation && (
          <Section title={`Root cause${rootCause.category ? ` (${String(rootCause.category).replace(/_/g, ' ').toLowerCase()})` : ''}`}>
            <p className="text-sm text-slate-300 leading-relaxed">{rootCause.explanation}</p>
          </Section>
        )}
        {data.question && (
          <Section title="Question for the human">
            <p className="text-sm text-slate-200 leading-relaxed">{data.question}</p>
          </Section>
        )}
        {data.humanDecision && (
          <Section title="Your decision">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <Pill tone={data.humanDecision === 'ABORT' ? 'red' : 'green'}>{data.humanDecision}</Pill>
            </div>
            {data.humanGuidance && (
              <blockquote className="border-l-2 border-blue-400 pl-3 text-sm text-slate-100 whitespace-pre-wrap break-words">
                {data.humanGuidance}
              </blockquote>
            )}
          </Section>
        )}
      </div>
    );
  }

  // --- Polish pass ---
  if (base === 'polish') {
    const candidates: any[] = Array.isArray(data.candidates) ? data.candidates : [];
    const applied = new Set<string>(Array.isArray(data.applied) ? data.applied : []);
    const declined: Array<{ id: string; reason: string }> = Array.isArray(data.declined) ? data.declined : [];
    const unanswered: string[] = Array.isArray(data.unanswered) ? data.unanswered : [];
    const reported: Array<{ source: string; summary: string; reason: string }> = Array.isArray(data.reported) ? data.reported : [];
    const files: string[] = Array.isArray(data.changedFiles) ? data.changedFiles : [];
    const reasonOf = new Map(declined.map((entry) => [entry.id, entry.reason]));
    const where = (c: any) => (c.file ? `${c.file}${c.line ? `:${c.line}` : ''}` : c.source === 'qa' ? 'found by QA' : '');
    const fixed = candidates.filter((c) => applied.has(c.id));
    const notFixed = candidates.filter((c) => !applied.has(c.id));

    const finding = (c: any, note?: string) => (
      <li key={c.id} className="text-sm text-slate-200">
        <span className="font-mono text-xs text-slate-400 mr-2">{c.id}</span>
        {c.problem}
        {where(c) && <div className="text-xs font-mono text-slate-400 mt-0.5">{where(c)}</div>}
        {note && <div className="text-xs text-amber-300 mt-0.5">{note}</div>}
      </li>
    );

    return (
      <div className="space-y-4">
        {header}
        {artifact.status === 'NONE' && (
          <p className="text-sm text-slate-300">QA, the review and the security audit left no minor findings to fix.</p>
        )}
        {artifact.status === 'SKIPPED' && (
          <p className="text-sm text-slate-300">
            {data.reason === 'NEEDS_QA'
              ? 'Skipped: the polish pass needs the QA stage, which runs the tests and the build that check its fixes.'
              : 'Switched off for this task: the minor findings are listed in the pull request, not fixed.'}
          </p>
        )}
        {(artifact.status === 'REVERTED' || artifact.status === 'FAILED') && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-sm text-amber-100">
            <div className="font-semibold mb-0.5">
              {artifact.status === 'REVERTED' ? 'Undone: the work is as it was before the polish' : 'The polish pass could not run'}
            </div>
            {data.detail}
          </div>
        )}
        {artifact.status === 'DECLINED' && (
          <p className="text-sm text-slate-300">
            The developer read the findings and changed nothing{data.detail && data.reason === 'BLOCKED' ? `: ${data.detail}` : ''}.
          </p>
        )}
        {artifact.status === 'APPLIED' && typeof data.developerSummary === 'string' && data.developerSummary !== '' && (
          <Section title="What the developer says">
            <p className="text-sm text-slate-300 leading-relaxed">{data.developerSummary}</p>
          </Section>
        )}
        {fixed.length > 0 && (
          <Section title={`Fixed (${fixed.length})`}>
            <ul className="space-y-2">{fixed.map((c) => finding(c))}</ul>
            {files.length > 0 && (
              <p className="text-xs text-slate-400 mt-2">
                Changed {files.length} file{files.length === 1 ? '' : 's'}, {data.changedLines} lines, after the review approved the code:
                {' '}
                <span className="font-mono">{files.join(', ')}</span>
              </p>
            )}
          </Section>
        )}
        {notFixed.length > 0 && (
          <Section title={`Not fixed (${notFixed.length})`}>
            <ul className="space-y-2">
              {notFixed.map((c) =>
                finding(
                  c,
                  reasonOf.get(c.id)
                    ? `Not fixed: ${reasonOf.get(c.id)}`
                    : unanswered.includes(c.id) || artifact.status === 'REVERTED' || artifact.status === 'FAILED'
                      ? 'Not fixed'
                      : undefined,
                ),
              )}
            </ul>
          </Section>
        )}
        {reported.length > 0 && (
          <Section title="Reported, never acted on">
            <ul className="space-y-1.5">
              {reported.map((item, index) => (
                <li key={index} className="text-sm text-slate-300">
                  {item.summary} <span className="text-xs text-slate-500">({item.reason})</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    );
  }

  // --- Run namer ---
  if (base === 'run-namer') {
    return (
      <div className="space-y-4">
        {header}
        {artifact.status === 'FALLBACK' && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-sm text-amber-100">
            <div className="font-semibold mb-0.5">Named from the request</div>
            The AI could not name this task{typeof data.error === 'string' ? ` (${data.error})` : ''}, so its first
            sentence was used instead. You can rename the run in the history.
          </div>
        )}
        <Section title="Title">
          <p className="text-sm text-slate-100">{data.title}</p>
        </Section>
        <Section title="Branch">
          <p className="text-sm font-mono text-slate-300">
            {data.type}-{data.slug}
          </p>
        </Section>
      </div>
    );
  }

  // --- PM Architect ---
  if (base === 'pm-architect' || base === 'pm-architect-plan') {
    const plan = data.plan || {};
    return (
      <div className="space-y-4">
        {header}
        {typeof data.reusedFrom === 'string' && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-sm text-amber-100">
            <div className="font-semibold mb-0.5">⊘ Skipped in this round</div>
            The plan of the previous round (<span className="font-mono">{data.reusedFrom}</span>) is reused, so the
            architect was not called again: the review comments went straight to the developer. The plan in use is
            shown below.
          </div>
        )}
        {typeof data.clarificationsUsed === 'string' && data.clarificationsUsed.trim() !== '' && (
          <Section title="Based on your answer">
            <blockquote className="border-l-2 border-blue-400 pl-3 text-sm text-slate-100 whitespace-pre-wrap break-words">
              {data.clarificationsUsed}
            </blockquote>
          </Section>
        )}
        {plan.summary && (
          <Section title="Plan Summary">
            <p className="text-sm text-slate-200 leading-relaxed">{plan.summary}</p>
          </Section>
        )}
        {plan.understanding && (
          <Section title="Understanding">
            <p className="text-sm text-slate-300 leading-relaxed">{plan.understanding}</p>
          </Section>
        )}
        {Array.isArray(plan.acceptanceCriteria) && plan.acceptanceCriteria.length > 0 && (
          <Section title={`Acceptance Criteria (${plan.acceptanceCriteria.length})`}>
            <ul className="space-y-1">
              {plan.acceptanceCriteria.map((c: string, i: number) => (
                <li key={i} className="text-xs text-slate-300 flex gap-2">
                  <span className="text-slate-500">☐</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {Array.isArray(plan.assumptions) && plan.assumptions.length > 0 && (
          <Section title="Assumptions">
            <ul className="space-y-1 list-disc list-inside">
              {plan.assumptions.map((a: string, i: number) => (
                <li key={i} className="text-xs text-slate-400">{a}</li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    );
  }

  // --- Developer ---
  if (base === 'developer') {
    // Split summary into bullet points if it contains numbered items or sentences
    const summaryPoints = data.summary 
      ? data.summary.split(/\n+/).filter((line: string) => line.trim())
      : [];
    
    return (
      <div className="space-y-4">
        {header}
        {summaryPoints.length > 0 && (
          <Section title="What the developer did">
            <ul className="space-y-2">
              {summaryPoints.map((point: string, i: number) => (
                <li key={i} className="text-sm text-slate-200 flex gap-2 leading-relaxed">
                  <span className="text-green-400 flex-shrink-0">✓</span>
                  <span>{point.replace(/^[-•*]\s*/, '').replace(/^\d+\.\s*/, '')}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {Array.isArray(data.changedFiles) && data.changedFiles.length > 0 && (
          <Section title={`Changed Files (${data.changedFiles.length})`}>
            <FileList files={data.changedFiles} />
          </Section>
        )}
        {Array.isArray(data.testsAdded) && data.testsAdded.length > 0 && (
          <Section title={`Tests Added (${data.testsAdded.length})`}>
            <ul className="space-y-1">
              {data.testsAdded.map((t: any, i: number) => (
                <li key={i} className="text-xs">
                  <span className="font-mono text-slate-200">{t.path}</span>
                  {t.level && <span className="ml-2 text-slate-500">[{t.level}]</span>}
                  {t.description && <div className="text-slate-400">{t.description}</div>}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {Array.isArray(data.followUps) && data.followUps.length > 0 && (
          <Section title="Follow-ups">
            <ul className="space-y-1 list-disc list-inside">
              {data.followUps.map((f: string, i: number) => (
                <li key={i} className="text-xs text-slate-400">{f}</li>
              ))}
            </ul>
          </Section>
        )}
        {Array.isArray(data.blockers) && data.blockers.length > 0 && (
          <Section title="Blockers">
            <ul className="space-y-1 list-disc list-inside">
              {data.blockers.map((b: string, i: number) => (
                <li key={i} className="text-xs text-red-300">{b}</li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    );
  }

  // --- QA Tester ---
  if (base === 'qa-tester') {
    const totals = data.totals || {};
    const bugs = Array.isArray(data.bugReports) ? data.bugReports : [];
    const failures = Array.isArray(data.failures) ? data.failures : [];
    const severityTone: Record<string, string> = {
      CRITICAL: 'red',
      MAJOR: 'red',
      MINOR: 'yellow',
    };
    
    // Split summary into bullet points
    const summaryPoints = data.summary 
      ? data.summary.split(/\n+/).filter((line: string) => line.trim())
      : [];
    
    return (
      <div className="space-y-4">
        {header}
        <div className="flex flex-wrap gap-2">
          <Pill tone={data.verdict === 'PASS' ? 'green' : 'red'}>Verdict: {data.verdict || '—'}</Pill>
          {typeof totals.tests === 'number' && (
            <Pill tone={totals.failed ? 'red' : 'green'}>
              {totals.passed}/{totals.tests} tests passed
            </Pill>
          )}
          {failures.length > 0 && <Pill tone="red">{failures.length} test failure{failures.length > 1 ? 's' : ''}</Pill>}
          {bugs.length > 0 && <Pill tone="red">{bugs.length} bug{bugs.length > 1 ? 's' : ''}</Pill>}
        </div>
        {summaryPoints.length > 0 && (
          <Section title="What QA tested">
            <ul className="space-y-2">
              {summaryPoints.map((point: string, i: number) => (
                <li key={i} className="text-sm text-slate-200 flex gap-2 leading-relaxed">
                  <span className="text-blue-400 flex-shrink-0">✓</span>
                  <span>{point.replace(/^[-•*]\s*/, '').replace(/^\d+\.\s*/, '')}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {Array.isArray(data.executedCommands) && data.executedCommands.length > 0 && (
          <Section title="Commands run">
            <ul className="space-y-1">
              {data.executedCommands.map((c: any, i: number) => (
                <li key={i} className="text-xs font-mono flex items-center gap-2">
                  <span className={c.exitCode === 0 ? 'text-green-400' : 'text-red-400'}>
                    exit {c.exitCode}
                  </span>
                  <span className="text-slate-300 break-all">{c.command}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {failures.length > 0 && (
          <Section title="Test Failures">
            <ul className="space-y-3">
              {failures.map((f: any, i: number) => (
                <li key={i} className="border border-red-500/30 bg-red-500/5 rounded p-3">
                  <div className="flex items-start gap-2 mb-2">
                    <svg className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-sm text-red-300 font-medium break-all mb-1">{f.testId}</div>
                      <div className="text-xs text-red-200/90 leading-relaxed mb-2">{f.message}</div>
                      {f.suspectedRootCause && (
                        <div className="text-xs text-slate-300 bg-slate-800/50 rounded p-2 mb-2">
                          <span className="font-semibold">Root cause: </span>
                          {f.suspectedRootCause}
                        </div>
                      )}
                      {f.file && (
                        <div className="text-xs text-slate-400 font-mono">
                          {f.file}{f.line ? `:${f.line}` : ''}
                        </div>
                      )}
                      {f.stackExcerpt && (
                        <details className="mt-2">
                          <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-300">Stack trace</summary>
                          <pre className="mt-1 text-xs text-slate-400 font-mono bg-slate-900/50 rounded p-2 overflow-x-auto">
                            {f.stackExcerpt}
                          </pre>
                        </details>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {bugs.length > 0 && (
          <Section title="Bug reports">
            <ul className="space-y-2">
              {bugs.map((b: any, i: number) => (
                <li key={i} className="border border-slate-700 rounded p-2">
                  <div className="flex items-center gap-2 mb-1">
                    <Pill tone={severityTone[b.severity] || 'slate'}>{b.severity}</Pill>
                    <span className="text-xs font-medium text-slate-200">{b.title}</span>
                  </div>
                  {b.actual && <p className="text-xs text-slate-400">Actual: {b.actual}</p>}
                  {b.expected && <p className="text-xs text-slate-400">Expected: {b.expected}</p>}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {data.recommendation && (
          <Section title="Recommendation">
            <p className="text-xs text-slate-300 leading-relaxed">{data.recommendation}</p>
          </Section>
        )}
      </div>
    );
  }

  // --- Triage ---
  if (base === 'triage') {
    const report = data.report || {};
    const rootCause = report.rootCause || {};
    const decision = data.effectiveDecision || report.decision || '—';
    
    return (
      <div className="space-y-4">
        {header}
        
        {/* Decision highlight box */}
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <span className="text-3xl">🔍</span>
            <div className="flex-1">
              <h4 className="text-lg font-bold text-blue-300 mb-2">
                Decision: {decision.replace(/_/g, ' ')}
              </h4>
              {rootCause.explanation && (
                <p className="text-sm text-slate-200 leading-relaxed mb-2">
                  {rootCause.explanation}
                </p>
              )}
              {rootCause.category && (
                <div className="flex items-center gap-2 mt-2">
                  <Pill tone="slate">Root cause: {rootCause.category.replace(/_/g, ' ')}</Pill>
                  {typeof report.confidence === 'number' && (
                    <Pill tone="slate">Confidence: {(report.confidence * 100).toFixed(0)}%</Pill>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        
        {report.summary && (
          <Section title="Detailed analysis">
            <p className="text-sm text-slate-200 leading-relaxed">{report.summary}</p>
          </Section>
        )}
        {Array.isArray(report.developerHints) && report.developerHints.length > 0 && (
          <Section title="Guidance for developer">
            <ul className="space-y-1 list-disc list-inside">
              {report.developerHints.map((h: string, i: number) => (
                <li key={i} className="text-xs text-slate-300">{h}</li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    );
  }

  // --- Code Reviewer ---
  if (base === 'reviewer' || base === 'code-review') {
    const findings = Array.isArray(data.findings) ? data.findings : [];
    const positives = Array.isArray(data.positives) ? data.positives : [];
    const mustFix = Array.isArray(data.mustFixBeforeMerge) ? data.mustFixBeforeMerge : [];
    const conventions = Array.isArray(data.conventionViolations) ? data.conventionViolations : [];
    const architectureNotes = Array.isArray(data.architectureNotes) ? data.architectureNotes : [];
    const severityTone: Record<string, string> = {
      CRITICAL: 'red',
      MAJOR: 'red',
      MINOR: 'yellow',
      NIT: 'slate',
    };
    
    // Get the overall status from either data.overallStatus or data.status
    const overallStatus = data.overallStatus || data.status || artifact.status;
    
    return (
      <div className="space-y-4">
        {header}
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={overallStatus.includes('APPROVED') ? 'green' : 'yellow'}>
            {overallStatus.replace(/_/g, ' ')}
          </Pill>
          {findings.length > 0 && <Pill tone="slate">{findings.length} finding{findings.length > 1 ? 's' : ''}</Pill>}
          {mustFix.length > 0 && <Pill tone="red">{ mustFix.length} must fix</Pill>}
          {data.scores && (
            <>
              {data.scores.correctness && <Pill tone="slate">Correctness: {data.scores.correctness}/5</Pill>}
              {data.scores.maintainability && <Pill tone="slate">Maintainability: {data.scores.maintainability}/5</Pill>}
            </>
          )}
        </div>
        {data.summary && (
          <Section title="Review summary">
            <p className="text-sm text-slate-200 leading-relaxed">{data.summary}</p>
          </Section>
        )}
        {mustFix.length > 0 && (
          <Section title="❗ Must fix before merge">
            <ul className="space-y-2">
              {mustFix.map((item: string, i: number) => (
                <li key={i} className="text-sm text-red-300 bg-red-900/20 rounded p-2">
                  {item}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {findings.length > 0 && (
          <Section title="Findings">
            <ul className="space-y-3">
              {findings.map((f: any, i: number) => (
                <li key={i} className="border border-slate-700 rounded-lg p-3">
                  <div className="flex items-start gap-2 mb-2">
                    <Pill tone={severityTone[f.severity] || 'slate'}>{f.severity}</Pill>
                    <span className="text-xs font-mono text-slate-400">{f.file}:{f.line}</span>
                  </div>
                  <p className="text-sm text-slate-200 mb-2">{f.issue}</p>
                  {f.suggestion && (
                    <p className="text-xs text-green-300 bg-green-900/20 rounded p-2">
                      <span className="font-semibold">Suggestion: </span>{f.suggestion}
                    </p>
                  )}
                  {f.rule && <p className="text-xs text-slate-400 mt-1">Rule: {f.rule}</p>}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {conventions.length > 0 && (
          <Section title="Convention notes">
            <ul className="space-y-2">
              {conventions.map((c: any, i: number) => (
                <li key={i} className="text-xs text-yellow-300 bg-yellow-900/20 rounded p-2">
                  <span className="font-semibold">{c.rule}</span>
                  {c.detail && <div className="text-slate-300 mt-1">{c.detail}</div>}
                  {c.file && <div className="text-slate-400 mt-1">File: {c.file}</div>}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {architectureNotes.length > 0 && (
          <Section title="Architecture notes">
            <ul className="space-y-1 list-disc list-inside">
              {architectureNotes.map((note: string, i: number) => (
                <li key={i} className="text-xs text-slate-300">{note}</li>
              ))}
            </ul>
          </Section>
        )}
        {positives.length > 0 && (
          <Section title="✓ Positives">
            <ul className="space-y-1 list-disc list-inside">
              {positives.map((pos: string, i: number) => (
                <li key={i} className="text-xs text-green-300">{pos}</li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    );
  }

  // --- Documentation (does the change make any documentation stale?) ---
  if (base === 'documentation') {
    const updated = Array.isArray(data.updatedFiles) ? data.updatedFiles : [];
    const entries: string[] = Array.isArray(data.changelogEntry?.entries) ? data.changelogEntry.entries : [];
    const followUps: string[] = Array.isArray(data.followUps) ? data.followUps : [];
    return (
      <div className="space-y-4">
        {header}
        {data.summary && (
          <Section title="What was checked">
            <p className="text-sm text-slate-200 leading-relaxed">{data.summary}</p>
          </Section>
        )}
        {updated.length > 0 && (
          <Section title={`Documentation updated (${updated.length})`}>
            <ul className="space-y-1.5" data-testid="docs-updated">
              {updated.map((file: any, i: number) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <Pill tone={file.changeType === 'ADDED' ? 'green' : 'blue'}>{file.changeType || 'CHANGED'}</Pill>
                  <div className="min-w-0">
                    <div className="font-mono text-slate-200 break-all">{file.path}</div>
                    {file.description && <div className="text-slate-400">{file.description}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {entries.length > 0 && (
          <Section title={`Changelog entry${data.changelogEntry?.section && data.changelogEntry.section !== 'None' ? ` (${data.changelogEntry.section})` : ''}`}>
            <ul className="list-disc list-inside text-sm text-slate-300 space-y-0.5">
              {entries.map((entry, i) => (
                <li key={i}>{entry}</li>
              ))}
            </ul>
          </Section>
        )}
        {data.openApiUpdated === true && data.openApiNotes && (
          <Section title="API specification">
            <p className="text-sm text-slate-300 leading-relaxed">{data.openApiNotes}</p>
          </Section>
        )}
        {followUps.length > 0 && (
          <Section title="Left for a human">
            <ul className="list-disc list-inside text-sm text-slate-300 space-y-0.5">
              {followUps.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </Section>
        )}
        <p className="text-xs text-slate-500">
          The commit message and the pull-request text are not written here: the PR Writer step does that.
        </p>
      </div>
    );
  }

  // --- PR Writer (the commit message, the pull-request title and its description) ---
  if (base === 'pr-writer') {
    const pr = data.pullRequest || {};
    const skipped = artifact.status.toUpperCase() === 'SKIPPED';
    const fallback = artifact.status.toUpperCase() === 'FALLBACK';
    const left: string[] = [
      ...(Array.isArray(data.omitted) ? data.omitted : []),
      ...(Array.isArray(data.shortened) ? data.shortened.map((f: string) => `${f} (cut short)`) : []),
    ];
    return (
      <div className="space-y-4">
        {header}

        {skipped && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-sm text-amber-100" data-testid="writer-skipped">
            <div className="font-semibold mb-0.5">⊘ Skipped</div>
            {data.note ?? 'There was nothing to write.'}
          </div>
        )}

        {fallback && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-sm text-amber-100" data-testid="writer-fallback">
            <div className="font-semibold mb-0.5">Drafted without the AI</div>
            {data.note}
            {data.error && (
              <details className="mt-2">
                <summary className="text-xs text-amber-200/80 cursor-pointer">What went wrong</summary>
                <pre className="mt-1 text-xs text-amber-100/80 whitespace-pre-wrap break-words">{data.error}</pre>
              </details>
            )}
          </div>
        )}

        {data.commitMessage && (
          <Section title="Commit message">
            <pre className="text-sm font-mono text-slate-100 bg-slate-800/60 rounded p-3 whitespace-pre-wrap break-words">{data.commitMessage}</pre>
          </Section>
        )}

        {pr.title && (
          <Section title="Pull request title">
            <p className="text-sm text-slate-100 font-medium">{pr.title}</p>
          </Section>
        )}

        {pr.body && (
          <Section title="Pull request description">
            <pre className="text-xs font-mono text-slate-200 bg-slate-800/60 rounded p-3 whitespace-pre-wrap break-words max-h-96 overflow-y-auto">{pr.body}</pre>
          </Section>
        )}

        {((Array.isArray(pr.labels) && pr.labels.length > 0) || pr.breakingChanges === true) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {(pr.labels ?? []).map((label: string, i: number) => (
              <Pill key={i} tone="blue">{label}</Pill>
            ))}
            {pr.breakingChanges === true && <Pill tone="red">breaking change</Pill>}
          </div>
        )}

        {left.length > 0 && (
          <p className="text-xs text-slate-500">
            Not shown to the writer: <span className="font-mono">{left.join(', ')}</span>
          </p>
        )}

        {!skipped && (
          <p className="text-xs text-slate-500">
            You can still change all of this at the delivery step before anything is published. The “Quality
            gates” section is written by the factory from the real results, not by the AI.
          </p>
        )}
      </div>
    );
  }

  // --- Delivery ---
  if (base === 'delivery' || base === 'pull-request') {
    // Delivery data is nested under data.delivery; older reports put it at the top level.
    const delivery = data.delivery || data;
    const pr = data.pullRequest || {};
    const notes = Array.isArray(delivery.notes) ? delivery.notes : [];
    const pendingActions = Array.isArray(delivery.pendingActions) ? delivery.pendingActions : [];
    const timeline = Array.isArray(data.timeline) ? data.timeline : [];
    const failure: string | null = data.error ?? (statusTone === 'red' ? (error ?? null) : null);
    const decision = data.decision as
      | { approvePush: boolean; approvePullRequest: boolean; source: 'human' | 'config' }
      | null
      | undefined;
    const baseBranch = data.baseBranch || 'main';

    return (
      <div className="space-y-4">
        {header}

        {failure && <ErrorBox title="Delivery failed" message={failure} />}

        <div className="flex flex-wrap items-center gap-2">
          {delivery.committed !== undefined && (
            <Pill tone={delivery.committed ? 'green' : 'slate'}>
              {delivery.committed ? '✓ Committed' : '○ Not committed'}
            </Pill>
          )}
          {delivery.pushed !== undefined && (
            <Pill tone={delivery.pushed ? 'green' : 'slate'}>
              {delivery.pushed ? '✓ Pushed' : '○ Not pushed'}
            </Pill>
          )}
          {delivery.pullRequestCreated !== undefined && (
            <Pill tone={delivery.pullRequestCreated ? 'blue' : 'slate'}>
              {delivery.pullRequestCreated
                ? artifact.status === 'PR_UPDATED'
                  ? '✓ PR Updated'
                  : '✓ PR Created'
                : '○ No PR'}
            </Pill>
          )}
          {decision && (
            <Pill tone="slate">
              {decision.source === 'human'
                ? decision.approvePush
                  ? decision.approvePullRequest
                    ? 'You approved: push + pull request'
                    : 'You approved: push only'
                  : 'You declined to push'
                : 'Automatic (no approval gate)'}
            </Pill>
          )}
        </div>

        {timeline.length > 0 && (
          <Section title="What delivery did">
            <DeliveryTimeline items={timeline} />
          </Section>
        )}

        {delivery.pullRequestUrl && (
          <Section title="✓ Pull Request">
            <a
              href={delivery.pullRequestUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 underline text-sm break-all font-mono"
            >
              {delivery.pullRequestUrl}
            </a>
          </Section>
        )}

        {notes.length > 0 && (
          <Section title="Notes">
            <ul className="space-y-1">
              {notes.map((note: string, i: number) => (
                <li key={i} className="text-sm text-slate-300 flex gap-2">
                  <span className="text-blue-400 flex-shrink-0">ℹ</span>
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {pendingActions.length > 0 && (
          <Section title="⚠️ Manual actions needed">
            <ul className="space-y-2">
              {pendingActions.map((action: string, i: number) => (
                <li
                  key={i}
                  className={`text-sm rounded p-2 break-words ${
                    action.startsWith('gh ')
                      ? 'font-mono text-xs bg-slate-900/60 text-slate-200'
                      : 'text-amber-300 bg-amber-900/20'
                  }`}
                >
                  {action.startsWith('gh ') ? `$ ${action}` : action}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {delivery.pushed &&
          !delivery.pullRequestCreated &&
          !pendingActions.some((action: string) => action.startsWith('gh ')) && (
            <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
              <p className="text-sm text-blue-300">✓ Branch pushed to the remote. Open the pull request yourself with:</p>
              <pre className="mt-2 text-xs font-mono bg-slate-900/50 p-2 rounded whitespace-pre-wrap break-all">
                {`gh pr create --base ${baseBranch} --head ${delivery.branch ?? '<branch>'} --fill`}
              </pre>
            </div>
          )}

        {delivery.commitMessage && (
          <Section title="Commit message">
            <p className="text-sm text-slate-200 font-mono leading-relaxed whitespace-pre-wrap break-words">{delivery.commitMessage}</p>
          </Section>
        )}

        {delivery.commitSha && (
          <Section title="Commit SHA">
            <p className="text-sm text-slate-300 font-mono">{delivery.commitSha}</p>
          </Section>
        )}

        {delivery.branch && (
          <Section title="Branch">
            <p className="text-sm text-slate-300 font-mono">
              {delivery.branch} <span className="text-slate-500">→ {baseBranch}</span>
            </p>
          </Section>
        )}

        {pr.title && (
          <Section title="PR Details">
            <div className="space-y-2">
              <div>
                <span className="text-xs text-slate-400">Title:</span>
                <p className="text-sm text-slate-200 font-medium">{pr.title}</p>
              </div>
              {pr.labels && pr.labels.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {pr.labels.map((label: string, i: number) => (
                    <Pill key={i} tone="blue">{label}</Pill>
                  ))}
                </div>
              )}
            </div>
          </Section>
        )}

        {data.summary && (
          <Section title="Summary">
            <p className="text-sm text-slate-200 leading-relaxed">{data.summary}</p>
          </Section>
        )}
      </div>
    );
  }

  // --- Fallback: generic summary ---
  const summary =
    data.summary || data.verdict || data.decision || artifact.status;
  return (
    <div className="space-y-4">
      {header}
      <Section title="Output">
        <p className="text-sm text-slate-300 leading-relaxed">
          {typeof summary === 'string' ? summary : JSON.stringify(summary, null, 2)}
        </p>
      </Section>
    </div>
  );
}
