/**
 * Live activity of the agents: what each model call is doing while it runs.
 *
 * Every agent call writes what it does, as it does it, to `logs/<runId>/activity.ndjson`: the model it
 * runs on, what it says it is going to do, every file it reads or edits and every search it makes, a
 * tool that failed, the moment it writes its report, and how the call ended. The Studio reads that file
 * to show each step's activity live, and the file stays with the run so the same story can be read later.
 *
 * Each entry names its call (`call`), role, step and attempt, so two steps that run side by side
 * (review and security) never mix, and nothing has to be guessed from timestamps.
 *
 * Three sources feed it:
 *   - the Claude Code CLI's `stream-json` output, through `ClaudeStreamParser` (see the recorded
 *     transcripts in `fixtures/claude-stream/` for what that stream contains);
 *   - the free tier, one entry per model asked and per outcome;
 *   - the `api` backend, one entry per tool call and per text step (Mastra's `onStepFinish`).
 *
 * A short human line is echoed to stdout for each entry as well, so the console (and the Studio's
 * "Live Output") shows the same thing. Writing is best effort: tracing never fails a call.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ensureRunTrace } from '../tools/logger-tools.ts';

export const ACTIVITY_FILE = 'activity.ndjson';

/**
 * - `call-start` : a model call began (model, backend).
 * - `thinking`   : the model thought before answering (its text is redacted by the API; the size is known).
 * - `text`       : what the model says while it works, streamed; entries of one `block` form one paragraph.
 * - `tool`       : a tool call, described in words ("Reading src/app.ts").
 * - `tool-error` : a tool call that failed, with the reason.
 * - `summary`    : the CLI's own one-line summary of a turn.
 * - `report`     : the model started writing its final, structured answer.
 * - `notice`     : something the factory did around the call (a retry, a fallback, a free model asked).
 * - `call-end`   : the call finished (duration, tokens, the model that answered).
 * - `call-failed`: the call failed (the reason).
 */
export type ActivityKind =
  | 'call-start'
  | 'thinking'
  | 'text'
  | 'tool'
  | 'tool-error'
  | 'summary'
  | 'report'
  | 'notice'
  | 'call-end'
  | 'call-failed';

export interface ActivityEntry {
  at: string;
  /** Identifies one agent call: `<step>#<attempt>#<n>`. */
  call: string;
  role: string;
  step: string;
  attempt: number;
  kind: ActivityKind;
  text: string;
  /** Text entries that share a block are pieces of the same paragraph. */
  block?: string;
  model?: string;
  backend?: string;
  tool?: string;
  durationMs?: number;
  tokens?: number;
}

/* -------------------------------------------------------------------------- */
/* Tool calls in words                                                         */
/* -------------------------------------------------------------------------- */

function relative(cwd: string, file: unknown): string {
  if (typeof file !== 'string' || file === '') return '';
  if (!path.isAbsolute(file) || cwd === '') return file;
  const rel = path.relative(cwd, file);
  return rel === '' ? '.' : rel.startsWith('..') ? file : rel;
}

function clip(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "Reading src/app.ts", "Searching for "useTheme" in src", ... - what a tool call is for, in words. */
export function describeToolUse(name: string, input: unknown, cwd: string): string {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const where = (key: string) => {
    const rel = relative(cwd, args[key]);
    return rel && rel !== '.' ? ` in ${rel}` : '';
  };
  switch (name) {
    case 'Read': {
      const range =
        typeof args.offset === 'number' ? ` (from line ${args.offset}${typeof args.limit === 'number' ? `, ${args.limit} lines` : ''})` : '';
      return `Reading ${relative(cwd, args.file_path) || 'a file'}${range}`;
    }
    case 'Glob':
      return `Listing files matching ${String(args.pattern ?? '*')}${where('path')}`;
    case 'Grep': {
      const filter = typeof args.glob === 'string' ? ` (${args.glob})` : typeof args.type === 'string' ? ` (${args.type} files)` : '';
      return `Searching for "${clip(String(args.pattern ?? ''), 80)}"${where('path')}${filter}`;
    }
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${relative(cwd, args.file_path) || 'a file'}`;
    case 'Write':
      return `Writing ${relative(cwd, args.file_path) || 'a file'}`;
    case 'NotebookEdit':
      return `Editing notebook ${relative(cwd, args.notebook_path) || ''}`.trim();
    case 'Bash':
      return `Running ${clip(String(args.command ?? ''), 100)}`;
    case 'TodoWrite': {
      const todos = Array.isArray(args.todos) ? args.todos.length : 0;
      return todos > 0 ? `Updating its plan (${todos} items)` : 'Updating its plan';
    }
    case 'WebFetch':
      return `Fetching ${String(args.url ?? '')}`.trim();
    case 'WebSearch':
      return `Searching the web for "${clip(String(args.query ?? ''), 80)}"`;
    case 'StructuredOutput':
      return 'Writing the final report';
    default: {
      // The factory's own tools under the `api` backend: kebab-case names, inputs worth a glance.
      const firstPath = ['path', 'filePath', 'file_path', 'file', 'directory'].map((key) => args[key]).find((v) => typeof v === 'string');
      if (typeof firstPath === 'string') return `${name} ${relative(cwd, firstPath)}`;
      const json = Object.keys(args).length > 0 ? ` ${clip(JSON.stringify(args), 100)}` : '';
      return `${name}${json}`;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Recorder                                                                    */
/* -------------------------------------------------------------------------- */

const ECHO_ICON: Partial<Record<ActivityKind, string>> = {
  'call-start': '▶',
  thinking: '…',
  text: '💬',
  tool: '🔧',
  'tool-error': '⚠',
  summary: '•',
  report: '📝',
  notice: 'ℹ',
  'call-end': '✓',
  'call-failed': '✗',
};

/** A text paragraph is flushed when it reaches this length (at a word boundary)... */
const FLUSH_CHARS = 160;
/** ...or when this long has passed since its first unflushed character. */
const FLUSH_MS = 400;

const callCounters = new Map<string, number>();

export interface ActivityRecorderOptions {
  runId: string;
  role: string;
  step: string;
  attempt: number;
  /** The repository, so paths can be shown relative to it. */
  cwd: string;
  /** Print a line to stdout for each entry (default true). */
  echo?: boolean;
}

/**
 * Writes the activity of one agent call. Text arrives in small deltas; it is gathered into readable
 * pieces (a line, a sentence, or what came in the last 400 ms) so the file and the screen are not flooded
 * with one-word entries, yet still move while the model writes.
 */
export class ActivityRecorder {
  readonly call: string;
  readonly cwd: string;
  private readonly file: string | null;
  private readonly echo: boolean;
  private readonly buffers = new Map<string, { kind: ActivityKind; text: string; since: number }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: ActivityRecorderOptions) {
    const key = `${options.runId}|${options.step}|${options.attempt}`;
    const n = (callCounters.get(key) ?? 0) + 1;
    callCounters.set(key, n);
    this.call = `${options.step}#${options.attempt}#${n}`;
    this.cwd = options.cwd;
    this.echo = options.echo ?? true;
    let file: string | null = null;
    try {
      file = path.join(ensureRunTrace(options.runId), ACTIVITY_FILE);
    } catch {
      file = null;
    }
    this.file = file;
  }

  /** Records one entry. */
  emit(kind: ActivityKind, text: string, extra: Partial<Omit<ActivityEntry, 'at' | 'call' | 'role' | 'step' | 'attempt' | 'kind' | 'text'>> = {}): void {
    const entry: ActivityEntry = {
      at: new Date().toISOString(),
      call: this.call,
      role: this.options.role,
      step: this.options.step,
      attempt: this.options.attempt,
      kind,
      text,
      ...extra,
    };
    if (this.file) {
      try {
        fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch {
        // Best effort: the call goes on without its trace.
      }
    }
    if (this.echo) {
      const line = clip(text, 200);
      if (line) process.stdout.write(`  [${this.options.role}] ${ECHO_ICON[kind] ?? ''} ${line}\n`);
    }
  }

  /** Adds a streamed piece of text to a paragraph (`block`). */
  text(block: string, delta: string, kind: ActivityKind = 'text'): void {
    if (!delta) return;
    const buffer = this.buffers.get(block) ?? { kind, text: '', since: Date.now() };
    if (buffer.text === '') buffer.since = Date.now();
    buffer.text += delta;
    this.buffers.set(block, buffer);

    const newline = buffer.text.lastIndexOf('\n');
    if (newline >= 0) {
      this.flushPart(block, newline + 1);
    } else if (buffer.text.length >= FLUSH_CHARS) {
      const space = buffer.text.lastIndexOf(' ');
      this.flushPart(block, space > FLUSH_CHARS / 2 ? space + 1 : buffer.text.length);
    } else if (Date.now() - buffer.since >= FLUSH_MS) {
      this.flushPart(block, buffer.text.length);
    }
    this.schedule();
  }

  /** The paragraph is complete: write what is left of it. */
  endBlock(block: string): void {
    const buffer = this.buffers.get(block);
    if (buffer && buffer.text !== '') this.flushPart(block, buffer.text.length);
    this.buffers.delete(block);
  }

  /** Writes whatever text is still gathered. Call when the call ends, however it ends. */
  close(): void {
    for (const block of [...this.buffers.keys()]) this.endBlock(block);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private flushPart(block: string, length: number): void {
    const buffer = this.buffers.get(block);
    if (!buffer) return;
    const part = buffer.text.slice(0, length);
    buffer.text = buffer.text.slice(length);
    buffer.since = Date.now();
    if (part.trim() !== '') this.emit(buffer.kind, part, { block: `${this.call}:${block}` });
  }

  /** Text that stops arriving mid-sentence (the model moved on to a tool) still shows within FLUSH_MS. */
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      let pending = false;
      for (const [block, buffer] of this.buffers) {
        if (buffer.text === '') continue;
        if (Date.now() - buffer.since >= FLUSH_MS) this.flushPart(block, buffer.text.length);
        else pending = true;
      }
      if (pending) this.schedule();
    }, FLUSH_MS);
    this.timer.unref?.();
  }
}

/* -------------------------------------------------------------------------- */
/* Claude Code stream-json                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Turns the Claude Code CLI's `--output-format stream-json --include-partial-messages` output into
 * activity. Feed it stdout chunks as they arrive; it keeps the incomplete last line for the next chunk.
 *
 * What it reads (see `fixtures/claude-stream/`):
 *   - `stream_event` text deltas: what the model says, live;
 *   - `stream_event` thinking blocks, with the size from `system`/`thinking_tokens` (the text is redacted);
 *   - `assistant` messages: each complete `tool_use`, with its input (the `StructuredOutput` tool is the
 *     final report being written);
 *   - `user` messages: `tool_result`s that failed;
 *   - `system`/`post_turn_summary`: the CLI's one-line summary of a turn.
 * Anything else (status pings, rate-limit notices, the final `result`) is left to the caller.
 */
export class ClaudeStreamParser {
  private pending = '';
  private message = 0;
  private sawPartials = false;
  private thinkingBlocks = new Set<number>();
  private thinkingTokens = 0;

  constructor(private readonly recorder: ActivityRecorder) {}

  /** A chunk of stdout. */
  push(chunk: string): void {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  /** The stream ended: read a last line that had no newline, and write any gathered text. */
  end(): void {
    if (this.pending.trim() !== '') this.line(this.pending);
    this.pending = '';
    this.recorder.close();
  }

  private line(raw: string): void {
    const line = raw.trim();
    if (!line.startsWith('{')) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    try {
      this.handle(event);
    } catch {
      // An event of a shape this parser does not know is skipped, never fatal.
    }
  }

  private handle(event: any): void {
    switch (event?.type) {
      case 'stream_event':
        this.streamEvent(event.event);
        return;
      case 'assistant':
        this.assistant(event.message?.content);
        return;
      case 'user':
        this.toolResults(event.message?.content);
        return;
      case 'system':
        if (event.subtype === 'thinking_tokens' && typeof event.estimated_tokens === 'number') {
          this.thinkingTokens = event.estimated_tokens;
        } else if (event.subtype === 'post_turn_summary' && typeof event.status_detail === 'string' && event.status_detail.trim()) {
          this.recorder.emit('summary', event.status_detail.trim());
        }
        return;
      default:
        return;
    }
  }

  private streamEvent(inner: any): void {
    if (!inner || typeof inner !== 'object') return;
    this.sawPartials = true;
    const index = typeof inner.index === 'number' ? inner.index : 0;
    const block = `m${this.message}b${index}`;
    switch (inner.type) {
      case 'message_start':
        this.message += 1;
        return;
      case 'content_block_start':
        if (inner.content_block?.type === 'thinking') {
          this.thinkingBlocks.add(index);
          this.thinkingTokens = 0;
        }
        return;
      case 'content_block_delta': {
        const delta = inner.delta ?? {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string') this.recorder.text(block, delta.text, 'text');
        // Thinking text is redacted today; should a model ever stream it, it is shown as thinking.
        else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
          this.recorder.text(block, delta.thinking, 'thinking');
        }
        return;
      }
      case 'content_block_stop':
        this.recorder.endBlock(block);
        if (this.thinkingBlocks.delete(index)) {
          this.recorder.emit('thinking', this.thinkingTokens > 0 ? `Thought it through (~${this.thinkingTokens} tokens)` : 'Thought it through');
        }
        return;
      default:
        return;
    }
  }

  private assistant(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const part of content as any[]) {
      if (part?.type === 'tool_use') {
        const name = String(part.name ?? 'tool');
        const kind = name === 'StructuredOutput' ? 'report' : 'tool';
        this.recorder.emit(kind, describeToolUse(name, part.input, this.recorder.cwd), { tool: name });
      } else if (part?.type === 'text' && !this.sawPartials && typeof part.text === 'string' && part.text.trim()) {
        // Without partial messages the text arrives whole, once per message.
        this.recorder.emit('text', part.text.trim(), { block: `${this.recorder.call}:whole${this.message}` });
      }
    }
  }

  private toolResults(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const part of content as any[]) {
      if (part?.type !== 'tool_result' || part.is_error !== true) continue;
      const text = typeof part.content === 'string' ? part.content : Array.isArray(part.content) ? part.content.map((c: any) => c?.text ?? '').join(' ') : '';
      this.recorder.emit('tool-error', clip(text || 'The tool call failed', 200));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Reading back                                                                */
/* -------------------------------------------------------------------------- */

/** The activity of a run, in order. Lines that cannot be read (torn while written) are skipped. */
export function readActivity(traceDir: string): ActivityEntry[] {
  let raw = '';
  try {
    raw = fs.readFileSync(path.join(traceDir, ACTIVITY_FILE), 'utf8');
  } catch {
    return [];
  }
  const entries: ActivityEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as ActivityEntry);
    } catch {
      // skip
    }
  }
  return entries;
}

/** "12.3s", "2m 05s". */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
