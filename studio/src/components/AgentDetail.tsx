import type { RunArtifact } from '../../shared/types';
import { formatDuration } from '../lib/format';

interface AgentDetailProps {
  step: string;
  artifact?: RunArtifact;
  logs?: string[]; // Streaming logs when artifact not yet available
  isRunning?: boolean;
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

export function AgentDetail({ step, artifact, logs, isRunning }: AgentDetailProps) {
  if (!artifact) {
    // Show streaming logs if available, otherwise show waiting message
    if (logs && logs.length > 0) {
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            {isRunning && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 text-xs">
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse"></span>
                Working...
              </span>
            )}
          </div>
          <div className="bg-slate-800/50 rounded-lg p-3 max-h-64 overflow-y-auto">
            <pre className="font-mono text-xs text-slate-300 whitespace-pre-wrap break-words">
              {logs.slice(-30).join('\n')}
            </pre>
          </div>
        </div>
      );
    }
    
    return (
      <div className="text-sm text-slate-400 italic flex items-center gap-2">
        {isRunning && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 text-xs">
            <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse"></span>
            Working...
          </span>
        )}
        <span>Waiting for output...</span>
      </div>
    );
  }

  const data = artifact.data || {};
  const statusTone =
    artifact.status === 'COMPLETED' || artifact.status === 'PASS'
      ? 'green'
      : artifact.status === 'FAIL'
      ? 'red'
      : 'yellow';

  const header = (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <Pill tone={statusTone as any}>{artifact.status}</Pill>
      {artifact.attempt > 1 && <Pill tone="yellow">Attempt {artifact.attempt}</Pill>}
      {artifact.model && <Pill tone="slate">{artifact.model}</Pill>}
      {typeof artifact.durationMs === 'number' && (
        <Pill tone="slate">{formatDuration(artifact.durationMs)}</Pill>
      )}
    </div>
  );

  // --- PM Architect ---
  if (step === 'pm-architect') {
    const plan = data.plan || {};
    return (
      <div className="space-y-4">
        {header}
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
  if (step === 'developer') {
    return (
      <div className="space-y-4">
        {header}
        {data.summary && (
          <Section title="What the developer did">
            <p className="text-sm text-slate-200 leading-relaxed">{data.summary}</p>
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
  if (step === 'qa-tester') {
    const totals = data.totals || {};
    const bugs = Array.isArray(data.bugReports) ? data.bugReports : [];
    const severityTone: Record<string, string> = {
      CRITICAL: 'red',
      MAJOR: 'red',
      MINOR: 'yellow',
    };
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
          {bugs.length > 0 && <Pill tone="red">{bugs.length} bug{bugs.length > 1 ? 's' : ''}</Pill>}
        </div>
        {data.summary && (
          <Section title="QA assessment">
            <p className="text-sm text-slate-200 leading-relaxed">{data.summary}</p>
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
  if (step === 'triage') {
    const report = data.report || {};
    const rootCause = report.rootCause || {};
    return (
      <div className="space-y-4">
        {header}
        <div className="flex flex-wrap gap-2">
          <Pill tone="blue">Decision: {data.effectiveDecision || report.decision || '—'}</Pill>
          {rootCause.category && <Pill tone="slate">Root cause: {rootCause.category}</Pill>}
          {typeof report.confidence === 'number' && (
            <Pill tone="slate">Confidence: {(report.confidence * 100).toFixed(0)}%</Pill>
          )}
        </div>
        {report.summary && (
          <Section title="Triage summary">
            <p className="text-sm text-slate-200 leading-relaxed">{report.summary}</p>
          </Section>
        )}
        {rootCause.explanation && (
          <Section title="Root cause">
            <p className="text-xs text-slate-300 leading-relaxed">{rootCause.explanation}</p>
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
