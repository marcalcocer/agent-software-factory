import { useEffect, useRef, useState } from 'react';

import type { FactoryRun } from '../../shared/types';

/** Where the name came from, in words, for the little label next to it. */
function sourceLabel(source: FactoryRun['titleSource'], why: string | undefined): { text: string; tone: string; hint: string } | null {
  switch (source) {
    case 'agent':
      return { text: '🏷 named by AI', tone: 'text-emerald-700 dark:text-emerald-300', hint: 'A small, cheap model named this task from your request.' };
    case 'fallback':
      return {
        text: '🏷 from your request',
        tone: 'text-amber-700 dark:text-amber-300',
        hint: `The AI could not name this task${why ? ` (${why})` : ''}, so the first sentence of your request is used.`,
      };
    case 'user':
      return { text: '✎ renamed by you', tone: 'text-slate-500 dark:text-slate-400', hint: 'You gave this run its name.' };
    default:
      return null;
  }
}

/**
 * The name of the run, where the run is on screen: who named it (the AI, your own words, or the fallback
 * and why), and double-click to rename it. Saved with the run; an error is shown here, not lost.
 */
export function RunTitle({
  title,
  source,
  why,
  task,
  onRename,
}: {
  title: string;
  source?: FactoryRun['titleSource'];
  /** Why the AI could not name the run, when it could not. */
  why?: string;
  task?: string;
  onRename?: (title: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setValue(title);
  }, [title, editing]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const commit = async () => {
    const next = value.trim().replace(/\s+/g, ' ');
    if (!next || next === title) {
      setEditing(false);
      setError(null);
      return;
    }
    setSaving(true);
    try {
      await onRename?.(next);
      setEditing(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const label = sourceLabel(source, why);

  if (editing) {
    return (
      <span className="inline-flex flex-col min-w-0">
        <input
          ref={input}
          data-testid="run-title-input"
          value={value}
          disabled={saving}
          maxLength={120}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void commit();
            if (event.key === 'Escape') {
              setValue(title);
              setEditing(false);
              setError(null);
            }
          }}
          className="px-2 py-0.5 rounded border border-blue-400 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-medium w-[32rem] max-w-full"
        />
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <span
        data-testid="run-title"
        onDoubleClick={() => onRename && setEditing(true)}
        title={`${onRename ? 'Double-click to rename\n\n' : ''}${task ?? ''}`}
        className={`truncate font-medium text-slate-900 dark:text-slate-100 ${onRename ? 'cursor-text' : ''}`}
      >
        {title}
      </span>
      {label && (
        <span data-testid="run-title-source" title={label.hint} className={`flex-shrink-0 text-xs ${label.tone}`}>
          {label.text}
        </span>
      )}
      {onRename && (
        <button
          onClick={() => setEditing(true)}
          title="Rename this run"
          aria-label="Rename this run"
          className="flex-shrink-0 text-xs text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        >
          ✎
        </button>
      )}
    </span>
  );
}
