import { useEffect, useRef } from 'react';

import { formatSeconds, groupCalls, type ActivityCall, type ActivityItem } from '../../shared/activity';
import { shortModelName } from '../../shared/modelRouting';
import type { ActivityEntry } from '../../shared/types';

const ICON: Record<ActivityItem['kind'], string> = {
  'call-start': '▶',
  thinking: '🧠',
  text: '💬',
  tool: '🔧',
  'tool-error': '⚠',
  summary: '•',
  report: '📝',
  notice: 'ℹ',
  'call-end': '✓',
  'call-failed': '✗',
};

const ITEM_STYLE: Record<ActivityItem['kind'], string> = {
  'call-start': 'text-slate-400',
  thinking: 'text-slate-400 italic',
  text: 'text-slate-100',
  tool: 'text-sky-300 font-mono text-[12px]',
  'tool-error': 'text-amber-300',
  summary: 'text-slate-300',
  report: 'text-violet-300',
  notice: 'text-amber-200',
  'call-end': 'text-green-400',
  'call-failed': 'text-red-400',
};

/** The bits of markdown models use while they talk: `code` and **bold**. Everything else stays as written. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
          <code key={i} className="rounded bg-slate-700/70 px-1 font-mono text-[12px] text-slate-100">
            {part.slice(1, -1)}
          </code>
        ) : part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
          <strong key={i}>
            <Inline text={part.slice(2, -2)} />
          </strong>
        ) : (
          part
        ),
      )}
    </>
  );
}

const timeOf = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

function CallHeader({ call, live }: { call: ActivityCall; live: boolean }) {
  const running = call.status === 'running' && live;
  const stopped = call.status === 'running' && !live;
  const backend = call.backend === 'free-tier' ? 'free tier' : call.backend === 'claude-cli' ? 'Claude' : call.backend;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 border-b border-slate-700/60 pb-1 mb-1">
      {call.attempt > 1 && <span className="text-yellow-300">Attempt {call.attempt}</span>}
      {call.model && <span className="font-mono text-slate-300">{shortModelName(call.model)}</span>}
      {backend && <span>· {backend}</span>}
      {running && (
        <span className="inline-flex items-center gap-1 text-blue-300">
          <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse"></span> working
        </span>
      )}
      {call.status === 'done' && (
        <span className="text-green-400">
          ✓ done{call.durationMs !== undefined ? ` in ${formatSeconds(call.durationMs)}` : ''}
          {call.tokens ? ` · ${call.tokens.toLocaleString()} tokens` : ''}
        </span>
      )}
      {call.status === 'failed' && <span className="text-red-400">✗ failed</span>}
      {stopped && <span className="text-slate-500">stopped</span>}
    </div>
  );
}

/**
 * What the agents of a step did, call by call: what they said (streamed), every file read or edited,
 * every search, a tool that failed, the report being written, the model and how the call ended. While
 * the step runs it follows the newest line, unless the reader scrolled up to read something earlier.
 */
export function ActivityFeed({ entries, live, maxHeight = 'max-h-96' }: { entries: ActivityEntry[]; live: boolean; maxHeight?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const calls = groupCalls(entries);

  useEffect(() => {
    const el = box.current;
    if (el && live && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, live]);

  if (calls.length === 0) return null;
  return (
    <div
      ref={box}
      data-testid="activity-feed"
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className={`bg-slate-900/80 border border-slate-700 rounded-lg p-3 ${maxHeight} overflow-y-auto space-y-3`}
    >
      {calls.map((call) => (
        <div key={call.call} data-testid="activity-call">
          <CallHeader call={call} live={live} />
          <ul className="space-y-1">
            {call.items
              .filter((item) => item.kind !== 'call-end')
              .map((item, index) => (
                <li key={index} className="flex items-start gap-2 text-sm leading-relaxed">
                  <span className="flex-shrink-0 w-4 text-center opacity-80">{ICON[item.kind]}</span>
                  <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${ITEM_STYLE[item.kind]}`}>
                    {item.kind === 'text' ? <Inline text={item.text.trim()} /> : item.text.trim()}
                  </span>
                  <span className="flex-shrink-0 text-[10px] text-slate-600 tabular-nums">{timeOf(item.at)}</span>
                </li>
              ))}
          </ul>
        </div>
      ))}
      {live && calls[calls.length - 1]?.status === 'running' && (
        <div className="flex items-center gap-1 pl-6 text-xs text-blue-300" aria-label="working">
          <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
          <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
          <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
        </div>
      )}
    </div>
  );
}
