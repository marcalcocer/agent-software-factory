/**
 * The initiative store: what a big piece of work is made of, and where each part of it stands.
 *
 *   Initiative  a goal the user gave ("redo the frontend"), for one repository
 *     Phase     one reviewable, mergeable step towards it (one pull request, and its rounds)
 *     Backlog   things seen on the way that nobody asked for: findings left unfixed, follow-ups
 *     Decision  what the user chose about a review comment that belongs to a later phase
 *
 * A quick task is an initiative with a single phase that nobody sees: every run belongs to a phase, so
 * a task that turns out to need more can become a project without starting over, and a review comment
 * that is really "later" has somewhere to go.
 *
 * SQLite (through libsql, which the workflow storage already uses) in its own file next to the run
 * logs: the run directories stay the record of what happened, this is the index of what is planned.
 * Several factory processes may write at once (WAL, a busy timeout, and every change is one
 * transaction); the Studio never opens the file - it asks the CLI, like it does for pull requests.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createClient, type Client, type InValue, type Row, type Transaction } from '@libsql/client';

import { getFactoryConfig } from '../utils/factory-config.ts';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type InitiativeKind = 'quick' | 'project' | 'greenfield';
export type InitiativeStatus = 'ACTIVE' | 'DONE' | 'ARCHIVED';

/**
 * PLANNED    in the roadmap, nothing started
 * RUNNING    a run (and its retries) is working on it
 * IN_REVIEW  its pull request is open
 * MERGED     delivered
 * SKIPPED    decided against, or found to be done already (the note says which)
 */
export type PhaseStatus = 'PLANNED' | 'RUNNING' | 'IN_REVIEW' | 'MERGED' | 'SKIPPED';

export interface Decision {
  /** What was asked. */
  questions: string[];
  /** What the user answered, as they wrote it. */
  answer: string;
  at: string;
}

export interface PhaseNote {
  at: string;
  /** `reconciler`, `user-request` (a review comment attached to the phase), `user`, `factory`. */
  source: string;
  text: string;
}

export interface InitiativeRow {
  id: string;
  repoPath: string;
  repoName: string;
  kind: InitiativeKind;
  title: string;
  /** The request that started it, as the user wrote it. */
  goal: string;
  status: InitiativeStatus;
  decisions: Decision[];
  constraints: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PhaseRow {
  id: string;
  initiativeId: string;
  ordinal: number;
  title: string;
  goal: string;
  scope: string[];
  acceptance: string[];
  /** Ids of the phases that must be merged (or skipped) first. */
  dependsOn: string[];
  status: PhaseStatus;
  taskId: string | null;
  rootRunId: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  mergedSha: string | null;
  mergedAt: string | null;
  /** What the phase delivered, once it is merged. */
  summary: string | null;
  notes: PhaseNote[];
  createdAt: string;
  updatedAt: string;
}

export type BacklogStatus = 'OPEN' | 'PROMOTED' | 'DISMISSED';

export interface BacklogRow {
  id: string;
  initiativeId: string;
  /** The phase it was seen in. */
  phaseId: string | null;
  /** `polish`, `qa`, `review`, `security`, `developer`, `documentation`, `reconciler`, `user`. */
  source: string;
  text: string;
  severity: string;
  evidence: string;
  /** The phase it probably belongs to. */
  suggestedPhaseId: string | null;
  status: BacklogStatus;
  createdAt: string;
}

export type ScopeChoice = 'DEFER' | 'DO_NOW';

export interface ScopeDecisionRow {
  id: number;
  prKey: string;
  commentId: string;
  initiativeId: string | null;
  fromPhaseId: string | null;
  /** The phase a deferred request went to (a new one has its own id). */
  targetPhaseId: string | null;
  decision: ScopeChoice;
  excerpt: string;
  decidedAt: string;
}

/** One line of a project's history: what happened to it, and when. */
export interface InitiativeEvent {
  id: number;
  initiativeId: string | null;
  type: string;
  data: unknown;
  at: string;
}

export interface InitiativeWithPhases extends InitiativeRow {
  phases: PhaseRow[];
  backlogOpen: number;
}

export interface NewPhase {
  title: string;
  goal?: string;
  scope?: string[];
  acceptance?: string[];
  /** Ordinals of earlier phases (the roadmap is written before the ids exist). */
  dependsOnOrdinals?: number[];
}

/* -------------------------------------------------------------------------- */
/* Database                                                                    */
/* -------------------------------------------------------------------------- */

/** Each entry takes the schema one version further. Append; never edit one that has shipped. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE initiatives (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    goal TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    decisions_json TEXT NOT NULL DEFAULT '[]',
    constraints_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX initiatives_by_repo ON initiatives (repo_path);

  CREATE TABLE phases (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL REFERENCES initiatives (id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    title TEXT NOT NULL,
    goal TEXT NOT NULL DEFAULT '',
    scope_json TEXT NOT NULL DEFAULT '[]',
    acceptance_json TEXT NOT NULL DEFAULT '[]',
    depends_on_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    task_id TEXT,
    root_run_id TEXT,
    branch TEXT,
    pr_number INTEGER,
    pr_url TEXT,
    merged_sha TEXT,
    merged_at TEXT,
    summary TEXT,
    notes_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (initiative_id, ordinal)
  );
  CREATE INDEX phases_by_task ON phases (task_id);
  CREATE INDEX phases_by_pr ON phases (pr_number);

  CREATE TABLE backlog (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL REFERENCES initiatives (id) ON DELETE CASCADE,
    phase_id TEXT,
    source TEXT NOT NULL,
    text TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'MINOR',
    evidence TEXT NOT NULL DEFAULT '',
    suggested_phase_id TEXT,
    status TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (initiative_id, fingerprint)
  );

  CREATE TABLE scope_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_key TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    initiative_id TEXT,
    from_phase_id TEXT,
    target_phase_id TEXT,
    decision TEXT NOT NULL,
    excerpt TEXT NOT NULL DEFAULT '',
    decided_at TEXT NOT NULL,
    UNIQUE (pr_key, comment_id)
  );

  CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    initiative_id TEXT,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    at TEXT NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export const storeFile = (): string => path.join(getFactoryConfig().logDir, 'initiatives.db');

const now = (): string => new Date().toISOString();

const parseJson = <T>(text: unknown, fallback: T): T => {
  try {
    return typeof text === 'string' ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const orNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const intOrNull = (value: unknown): number | null => (typeof value === 'number' || typeof value === 'bigint' ? Number(value) : null);

/** `i0007`, `b0012`: a letter and at least four digits. */
const formatId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(4, '0')}`;

/** What makes two backlog entries the same: the words, not the punctuation or the case. */
export const fingerprintOf = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 160);

function initiativeFrom(row: Row): InitiativeRow {
  return {
    id: str(row.id),
    repoPath: str(row.repo_path),
    repoName: str(row.repo_name),
    kind: str(row.kind) as InitiativeKind,
    title: str(row.title),
    goal: str(row.goal),
    status: str(row.status) as InitiativeStatus,
    decisions: parseJson<Decision[]>(row.decisions_json, []),
    constraints: parseJson<string[]>(row.constraints_json, []),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function phaseFrom(row: Row): PhaseRow {
  return {
    id: str(row.id),
    initiativeId: str(row.initiative_id),
    ordinal: Number(row.ordinal),
    title: str(row.title),
    goal: str(row.goal),
    scope: parseJson<string[]>(row.scope_json, []),
    acceptance: parseJson<string[]>(row.acceptance_json, []),
    dependsOn: parseJson<string[]>(row.depends_on_json, []),
    status: str(row.status) as PhaseStatus,
    taskId: orNull(row.task_id),
    rootRunId: orNull(row.root_run_id),
    branch: orNull(row.branch),
    prNumber: intOrNull(row.pr_number),
    prUrl: orNull(row.pr_url),
    mergedSha: orNull(row.merged_sha),
    mergedAt: orNull(row.merged_at),
    summary: orNull(row.summary),
    notes: parseJson<PhaseNote[]>(row.notes_json, []),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function backlogFrom(row: Row): BacklogRow {
  return {
    id: str(row.id),
    initiativeId: str(row.initiative_id),
    phaseId: orNull(row.phase_id),
    source: str(row.source),
    text: str(row.text),
    severity: str(row.severity),
    evidence: str(row.evidence),
    suggestedPhaseId: orNull(row.suggested_phase_id),
    status: str(row.status) as BacklogStatus,
    createdAt: str(row.created_at),
  };
}

function decisionFrom(row: Row): ScopeDecisionRow {
  return {
    id: Number(row.id),
    prKey: str(row.pr_key),
    commentId: str(row.comment_id),
    initiativeId: orNull(row.initiative_id),
    fromPhaseId: orNull(row.from_phase_id),
    targetPhaseId: orNull(row.target_phase_id),
    decision: str(row.decision) as ScopeChoice,
    excerpt: str(row.excerpt),
    decidedAt: str(row.decided_at),
  };
}

/** A phase's columns, as an `UPDATE ... SET` list, for the fields a patch can carry. */
const PHASE_COLUMNS: Record<string, { column: string; encode?: (value: never) => InValue }> = {
  title: { column: 'title' },
  goal: { column: 'goal' },
  scope: { column: 'scope_json', encode: ((v: string[]) => JSON.stringify(v)) as never },
  acceptance: { column: 'acceptance_json', encode: ((v: string[]) => JSON.stringify(v)) as never },
  dependsOn: { column: 'depends_on_json', encode: ((v: string[]) => JSON.stringify(v)) as never },
  status: { column: 'status' },
  taskId: { column: 'task_id' },
  rootRunId: { column: 'root_run_id' },
  branch: { column: 'branch' },
  prNumber: { column: 'pr_number' },
  prUrl: { column: 'pr_url' },
  mergedSha: { column: 'merged_sha' },
  mergedAt: { column: 'merged_at' },
  summary: { column: 'summary' },
  notes: { column: 'notes_json', encode: ((v: PhaseNote[]) => JSON.stringify(v)) as never },
};

export type PhasePatch = Partial<{
  title: string;
  goal: string;
  scope: string[];
  acceptance: string[];
  dependsOn: string[];
  status: PhaseStatus;
  taskId: string | null;
  rootRunId: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  mergedSha: string | null;
  mergedAt: string | null;
  summary: string | null;
  notes: PhaseNote[];
}>;

/* -------------------------------------------------------------------------- */
/* The store                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One connection per file per process, shared by every store opened on it.
 *
 * libsql's native calls are synchronous: a second connection of the same process waiting for the lock
 * that the first holds across an `await` blocks the one thread that could release it - a deadlock that
 * only ends when the busy timeout does. So a process has one connection, and its write transactions
 * take turns (`queue`). Other processes are different threads: SQLite's busy handler waits for them.
 */
interface Shared {
  file: string;
  db: Client;
  refs: number;
  queue: Promise<unknown>;
}

const open = new Map<string, Shared>();

export class InitiativeStore {
  private readonly db: Client;
  private closed = false;

  constructor(private readonly shared: Shared) {
    this.db = shared.db;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.shared.refs -= 1;
    if (this.shared.refs === 0) {
      open.delete(this.shared.file);
      this.shared.db.close();
    }
  }

  /* ---- plumbing ---- */

  private async all<T>(sql: string, args: InValue[], map: (row: Row) => T): Promise<T[]> {
    return (await this.db.execute({ sql, args })).rows.map(map);
  }

  private async one<T>(sql: string, args: InValue[], map: (row: Row) => T): Promise<T | null> {
    return (await this.all(sql, args, map))[0] ?? null;
  }

  /** Runs `work` as one transaction: all of it happens, or none. Transactions of one process take turns. */
  private write<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const tx = await this.db.transaction('write');
      try {
        const result = await work(tx);
        await tx.commit();
        return result;
      } catch (error) {
        await tx.rollback().catch(() => {});
        throw error;
      } finally {
        tx.close();
      }
    };
    const turn = this.shared.queue.then(run, run);
    this.shared.queue = turn.catch(() => {});
    return turn;
  }

  /** The next number of a counter. Never goes back, whatever is deleted. */
  private async nextNumber(tx: Transaction, name: string): Promise<number> {
    const result = await tx.execute({
      sql: 'INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET value = value + 1 RETURNING value',
      args: [name],
    });
    return Number(result.rows[0]!.value);
  }

  private async record(tx: Transaction, initiativeId: string | null, type: string, payload: unknown = {}): Promise<void> {
    await tx.execute({
      sql: 'INSERT INTO events (initiative_id, type, payload_json, at) VALUES (?, ?, ?, ?)',
      args: [initiativeId, type, JSON.stringify(payload), now()],
    });
  }

  /* ---- initiatives ---- */

  async createInitiative(input: {
    repoPath: string;
    title: string;
    goal: string;
    kind?: InitiativeKind;
    decisions?: Decision[];
    constraints?: string[];
    /** Phase 1: the task the initiative starts with. Absent: a roadmap is written first. */
    firstPhase?: NewPhase & { status?: PhaseStatus };
  }): Promise<InitiativeWithPhases> {
    const id = await this.write(async (tx) => {
      const number = await this.nextNumber(tx, 'initiative');
      const initiativeId = formatId('i', number);
      const at = now();
      await tx.execute({
        sql: `INSERT INTO initiatives (id, repo_path, repo_name, kind, title, goal, status, decisions_json, constraints_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`,
        args: [
          initiativeId,
          input.repoPath,
          path.basename(input.repoPath),
          input.kind ?? 'quick',
          input.title,
          input.goal,
          JSON.stringify(input.decisions ?? []),
          JSON.stringify(input.constraints ?? []),
          at,
          at,
        ],
      });
      if (input.firstPhase) await this.insertPhase(tx, initiativeId, 1, input.firstPhase, input.firstPhase.status ?? 'PLANNED', []);
      await this.record(tx, initiativeId, 'initiative_created', { kind: input.kind ?? 'quick', title: input.title });
      return initiativeId;
    });
    return (await this.getInitiative(id))!;
  }

  private async insertPhase(
    tx: Transaction,
    initiativeId: string,
    ordinal: number,
    phase: NewPhase,
    status: PhaseStatus,
    dependsOn: string[],
  ): Promise<string> {
    const id = `${initiativeId}-p${ordinal}`;
    const at = now();
    await tx.execute({
      sql: `INSERT INTO phases (id, initiative_id, ordinal, title, goal, scope_json, acceptance_json, depends_on_json, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        initiativeId,
        ordinal,
        phase.title,
        phase.goal ?? '',
        JSON.stringify(phase.scope ?? []),
        JSON.stringify(phase.acceptance ?? []),
        JSON.stringify(dependsOn),
        status,
        at,
        at,
      ],
    });
    return id;
  }

  async getInitiative(id: string): Promise<InitiativeWithPhases | null> {
    const row = await this.one('SELECT * FROM initiatives WHERE id = ?', [id], initiativeFrom);
    return row ? await this.withPhases(row) : null;
  }

  private async withPhases(row: InitiativeRow): Promise<InitiativeWithPhases> {
    const phases = await this.all('SELECT * FROM phases WHERE initiative_id = ? ORDER BY ordinal', [row.id], phaseFrom);
    const open = await this.one("SELECT COUNT(*) AS c FROM backlog WHERE initiative_id = ? AND status = 'OPEN'", [row.id], (r) => Number(r.c));
    return { ...row, phases, backlogOpen: open ?? 0 };
  }

  /** Newest first. Quick tasks (a single phase nobody planned) are left out unless asked for. */
  async listInitiatives(repoPath: string, options: { includeQuick?: boolean; includeArchived?: boolean } = {}): Promise<InitiativeWithPhases[]> {
    const rows = await this.all('SELECT * FROM initiatives WHERE repo_path = ? ORDER BY id DESC', [repoPath], initiativeFrom);
    const wanted = rows.filter(
      (row) => (options.includeQuick || row.kind !== 'quick') && (options.includeArchived || row.status !== 'ARCHIVED'),
    );
    return await Promise.all(wanted.map((row) => this.withPhases(row)));
  }

  async updateInitiative(id: string, patch: Partial<Pick<InitiativeRow, 'title' | 'goal' | 'kind' | 'status' | 'constraints' | 'decisions'>>): Promise<void> {
    const sets: string[] = [];
    const args: InValue[] = [];
    const add = (column: string, value: InValue) => {
      sets.push(`${column} = ?`);
      args.push(value);
    };
    if (patch.title !== undefined) add('title', patch.title);
    if (patch.goal !== undefined) add('goal', patch.goal);
    if (patch.kind !== undefined) add('kind', patch.kind);
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.constraints !== undefined) add('constraints_json', JSON.stringify(patch.constraints));
    if (patch.decisions !== undefined) add('decisions_json', JSON.stringify(patch.decisions));
    if (sets.length === 0) return;
    await this.write((tx) => tx.execute({ sql: `UPDATE initiatives SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, args: [...args, now(), id] }));
  }

  /* ---- phases ---- */

  async getPhase(id: string): Promise<PhaseRow | null> {
    return await this.one('SELECT * FROM phases WHERE id = ?', [id], phaseFrom);
  }

  async findPhaseByTask(taskId: string): Promise<PhaseRow | null> {
    return await this.one('SELECT * FROM phases WHERE task_id = ?', [taskId], phaseFrom);
  }

  /** The phase whose pull request this is. */
  async findPhaseByPullRequest(repoPath: string, number: number): Promise<PhaseRow | null> {
    return await this.one(
      `SELECT p.* FROM phases p JOIN initiatives i ON i.id = p.initiative_id
        WHERE i.repo_path = ? AND p.pr_number = ? ORDER BY p.updated_at DESC`,
      [repoPath, number],
      phaseFrom,
    );
  }

  async updatePhase(id: string, patch: PhasePatch): Promise<void> {
    const sets: string[] = [];
    const args: InValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const spec = PHASE_COLUMNS[key];
      if (!spec || value === undefined) continue;
      sets.push(`${spec.column} = ?`);
      args.push(spec.encode ? spec.encode(value as never) : (value as InValue));
    }
    if (sets.length === 0) return;
    await this.write((tx) => tx.execute({ sql: `UPDATE phases SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, args: [...args, now(), id] }));
  }

  /** Appends a phase to the end of the roadmap. */
  async addPhase(initiativeId: string, phase: NewPhase): Promise<PhaseRow> {
    const id = await this.write(async (tx) => {
      const last = await tx.execute({ sql: 'SELECT COALESCE(MAX(ordinal), 0) AS n FROM phases WHERE initiative_id = ?', args: [initiativeId] });
      const ordinal = Number(last.rows[0]!.n) + 1;
      const dependsOn = (phase.dependsOnOrdinals ?? []).filter((n) => n < ordinal).map((n) => `${initiativeId}-p${n}`);
      const phaseId = await this.insertPhase(tx, initiativeId, ordinal, phase, 'PLANNED', dependsOn);
      await this.record(tx, initiativeId, 'phase_added', { phaseId, title: phase.title });
      return phaseId;
    });
    return (await this.getPhase(id))!;
  }

  /**
   * Writes the roadmap the architect proposed. Phase 1 is the phase that is being planned right now: it
   * keeps its run and takes the roadmap's words. The others replace whatever PLANNED phases there were,
   * so planning the same task again (after the human answered a question) does not add a second copy.
   * Phases that have started or finished are never touched.
   *
   * `dependsOnOrdinals` of a roadmap entry are positions in the roadmap (1 = the first entry).
   */
  async setRoadmap(
    initiativeId: string,
    roadmap: { title: string; phases: NewPhase[]; decisions?: Decision[]; constraints?: string[] },
  ): Promise<InitiativeWithPhases> {
    await this.write(async (tx) => {
      const current = (await tx.execute({ sql: 'SELECT * FROM phases WHERE initiative_id = ? ORDER BY ordinal', args: [initiativeId] })).rows.map(phaseFrom);
      const first = current.find((phase) => phase.ordinal === 1);
      const [head, ...rest] = roadmap.phases;
      if (!first || !head || rest.length === 0) throw new Error('A roadmap needs the phase being planned and at least one more.');
      const at = now();

      // Phase 1: the roadmap's words, the run's links.
      await tx.execute({
        sql: 'UPDATE phases SET title = ?, goal = ?, scope_json = ?, acceptance_json = ?, updated_at = ? WHERE id = ?',
        args: [head.title, head.goal ?? '', JSON.stringify(head.scope ?? []), JSON.stringify(head.acceptance ?? []), at, first.id],
      });

      // The planned ones are replaced; the ones that started stay where they are.
      await tx.execute({ sql: "DELETE FROM phases WHERE initiative_id = ? AND ordinal > 1 AND status = 'PLANNED'", args: [initiativeId] });
      const kept = current.filter((phase) => phase.ordinal > 1 && phase.status !== 'PLANNED');
      let ordinal = Math.max(1, ...kept.map((phase) => phase.ordinal));

      const idAt = new Map<number, string>([[1, first.id]]);
      for (const [index, phase] of rest.entries()) {
        const position = index + 2; // its place in the roadmap
        ordinal += 1;
        const wanted = phase.dependsOnOrdinals ?? [position - 1];
        const dependsOn = wanted.filter((n) => n < position).map((n) => idAt.get(n)).filter((id): id is string => Boolean(id));
        idAt.set(position, await this.insertPhase(tx, initiativeId, ordinal, phase, 'PLANNED', dependsOn));
      }

      const decisions =
        roadmap.decisions ??
        parseJson<Decision[]>((await tx.execute({ sql: 'SELECT decisions_json AS d FROM initiatives WHERE id = ?', args: [initiativeId] })).rows[0]?.d, []);
      await tx.execute({
        sql: `UPDATE initiatives SET kind = CASE WHEN kind = 'quick' THEN 'project' ELSE kind END, title = ?,
                decisions_json = ?, constraints_json = ?, updated_at = ? WHERE id = ?`,
        args: [roadmap.title, JSON.stringify(decisions), JSON.stringify(roadmap.constraints ?? []), at, initiativeId],
      });
      await this.record(tx, initiativeId, 'roadmap_set', { phases: roadmap.phases.map((phase) => phase.title) });
    });
    return (await this.getInitiative(initiativeId))!;
  }

  /** A run has started on the phase. */
  async linkRun(phaseId: string, run: { taskId: string; rootRunId: string; branch: string | null }): Promise<void> {
    await this.updatePhase(phaseId, { status: 'RUNNING', taskId: run.taskId, rootRunId: run.rootRunId, branch: run.branch });
  }

  /** The phase's pull request is open. */
  async linkPullRequest(phaseId: string, pr: { number: number; url: string; branch?: string }): Promise<void> {
    await this.updatePhase(phaseId, { status: 'IN_REVIEW', prNumber: pr.number, prUrl: pr.url, ...(pr.branch ? { branch: pr.branch } : {}) });
  }

  /** The pull request was merged: the phase is delivered, and the initiative is done when nothing is left. */
  async markMerged(phaseId: string, merge: { sha?: string | null; at?: string | null } = {}): Promise<{ phase: PhaseRow; initiative: InitiativeWithPhases } | null> {
    const phase = await this.getPhase(phaseId);
    if (!phase) return null;
    await this.write(async (tx) => {
      await tx.execute({
        sql: "UPDATE phases SET status = 'MERGED', merged_sha = COALESCE(?, merged_sha), merged_at = COALESCE(?, merged_at, ?), updated_at = ? WHERE id = ?",
        args: [merge.sha ?? null, merge.at ?? null, now(), now(), phaseId],
      });
      const left = await tx.execute({
        sql: "SELECT COUNT(*) AS c FROM phases WHERE initiative_id = ? AND status NOT IN ('MERGED', 'SKIPPED')",
        args: [phase.initiativeId],
      });
      if (Number(left.rows[0]!.c) === 0) {
        await tx.execute({ sql: "UPDATE initiatives SET status = 'DONE', updated_at = ? WHERE id = ? AND status = 'ACTIVE'", args: [now(), phase.initiativeId] });
      }
      await this.record(tx, phase.initiativeId, 'phase_merged', { phaseId, sha: merge.sha ?? null });
    });
    return { phase: (await this.getPhase(phaseId))!, initiative: (await this.getInitiative(phase.initiativeId))! };
  }

  /** The pull request was closed without merging: the phase goes back to the roadmap. */
  async markClosedUnmerged(phaseId: string): Promise<void> {
    const phase = await this.getPhase(phaseId);
    if (!phase || phase.status === 'MERGED') return;
    await this.write(async (tx) => {
      await tx.execute({
        sql: "UPDATE phases SET status = 'PLANNED', pr_number = NULL, pr_url = NULL, updated_at = ? WHERE id = ?",
        args: [now(), phaseId],
      });
      await this.record(tx, phase.initiativeId, 'phase_closed_unmerged', { phaseId, pr: phase.prNumber });
    });
    // What the roadmap shows next to the phase must be what happened to it, not what happened the time before.
    await this.appendNotes(phaseId, [
      { source: 'factory', text: `${phase.prNumber ? `Pull request #${phase.prNumber} was` : 'Its pull request was'} closed without being merged, so this phase is waiting again. Run it again, or skip it.` },
    ]);
  }

  /**
   * A run of this phase ended without opening a pull request - it delivered on its branch only, was
   * aborted, or was escalated and never resumed - so the phase is not running any more and not in review
   * either. It goes back to the roadmap, waiting, with a note saying what happened: otherwise it stays
   * "running" for ever, and neither starting it again nor editing it is allowed.
   *
   * Only a phase that is running and has no pull request is released: one in review (a further round that
   * delivered nothing) or merged is exactly where it was. Returns whether it was released.
   */
  async releasePhase(phaseId: string, note: string): Promise<boolean> {
    const phase = await this.getPhase(phaseId);
    if (!phase || phase.status !== 'RUNNING' || phase.prNumber !== null) return false;
    await this.write(async (tx) => {
      await tx.execute({
        sql: "UPDATE phases SET status = 'PLANNED', updated_at = ? WHERE id = ? AND status = 'RUNNING' AND pr_number IS NULL",
        args: [now(), phaseId],
      });
      await this.record(tx, phase.initiativeId, 'phase_released', { phaseId, reason: note });
    });
    await this.appendNotes(phaseId, [{ source: 'factory', text: note }]);
    return true;
  }

  async appendNotes(phaseId: string, notes: Array<Omit<PhaseNote, 'at'>>): Promise<void> {
    if (notes.length === 0) return;
    const phase = await this.getPhase(phaseId);
    if (!phase) return;
    const at = now();
    await this.updatePhase(phaseId, { notes: [...phase.notes, ...notes.map((note) => ({ at, ...note }))] });
  }

  /** The first planned phase whose dependencies are delivered: what the user can start now. */
  async nextPhase(initiativeId: string): Promise<PhaseRow | null> {
    const initiative = await this.getInitiative(initiativeId);
    if (!initiative) return null;
    const done = new Set(initiative.phases.filter((p) => p.status === 'MERGED' || p.status === 'SKIPPED').map((p) => p.id));
    return initiative.phases.find((p) => p.status === 'PLANNED' && p.dependsOn.every((dep) => done.has(dep))) ?? null;
  }

  /* ---- backlog ---- */

  /** Adds what was seen on the way. The same finding twice (same words) is kept once. Returns how many were new. */
  async addBacklog(
    initiativeId: string,
    items: Array<{ source: string; text: string; severity?: string; evidence?: string; phaseId?: string | null; suggestedPhaseId?: string | null }>,
  ): Promise<number> {
    let added = 0;
    await this.write(async (tx) => {
      for (const item of items) {
        const text = item.text.replace(/\s+/g, ' ').trim();
        if (text === '') continue;
        const fingerprint = fingerprintOf(text);
        const exists = await tx.execute({ sql: 'SELECT 1 FROM backlog WHERE initiative_id = ? AND fingerprint = ?', args: [initiativeId, fingerprint] });
        if (exists.rows.length > 0) continue;
        const id = formatId('b', await this.nextNumber(tx, 'backlog'));
        await tx.execute({
          sql: `INSERT INTO backlog (id, initiative_id, phase_id, source, text, severity, evidence, suggested_phase_id, status, fingerprint, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
          args: [id, initiativeId, item.phaseId ?? null, item.source, text, item.severity ?? 'MINOR', item.evidence ?? '', item.suggestedPhaseId ?? null, fingerprint, now()],
        });
        added += 1;
      }
    });
    return added;
  }

  async listBacklog(initiativeId: string, status?: BacklogStatus): Promise<BacklogRow[]> {
    return await this.all(
      `SELECT * FROM backlog WHERE initiative_id = ? ${status ? 'AND status = ?' : ''} ORDER BY id`,
      status ? [initiativeId, status] : [initiativeId],
      backlogFrom,
    );
  }

  async setBacklogStatus(id: string, status: BacklogStatus): Promise<void> {
    await this.write((tx) => tx.execute({ sql: 'UPDATE backlog SET status = ? WHERE id = ?', args: [status, id] }));
  }

  async getBacklogItem(id: string): Promise<BacklogRow | null> {
    return await this.one('SELECT * FROM backlog WHERE id = ?', [id], backlogFrom);
  }

  /* ---- decisions about review comments ---- */

  async recordScopeDecision(input: Omit<ScopeDecisionRow, 'id' | 'decidedAt'>): Promise<ScopeDecisionRow> {
    await this.write((tx) =>
      tx.execute({
        sql: `INSERT INTO scope_decisions (pr_key, comment_id, initiative_id, from_phase_id, target_phase_id, decision, excerpt, decided_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (pr_key, comment_id) DO UPDATE SET decision = excluded.decision, target_phase_id = excluded.target_phase_id,
                initiative_id = excluded.initiative_id, from_phase_id = excluded.from_phase_id, excerpt = excluded.excerpt, decided_at = excluded.decided_at`,
        args: [input.prKey, input.commentId, input.initiativeId, input.fromPhaseId, input.targetPhaseId, input.decision, input.excerpt, now()],
      }),
    );
    return (await this.one('SELECT * FROM scope_decisions WHERE pr_key = ? AND comment_id = ?', [input.prKey, input.commentId], decisionFrom))!;
  }

  async listScopeDecisions(prKey: string): Promise<ScopeDecisionRow[]> {
    return await this.all('SELECT * FROM scope_decisions WHERE pr_key = ? ORDER BY id', [prKey], decisionFrom);
  }

  /* ---- audit ---- */

  async log(initiativeId: string | null, type: string, payload: unknown = {}): Promise<void> {
    await this.write((tx) => this.record(tx, initiativeId, type, payload));
  }

  /** What happened to a project, oldest first. */
  async listEvents(initiativeId: string): Promise<InitiativeEvent[]> {
    return await this.all('SELECT * FROM events WHERE initiative_id = ? ORDER BY id', [initiativeId], (row) => {
      let data: unknown = {};
      try {
        data = JSON.parse(str(row.payload_json));
      } catch {
        // A line that cannot be read is still a line that happened.
      }
      return { id: Number(row.id), initiativeId: orNull(row.initiative_id), type: str(row.type), data, at: str(row.at) };
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Opening it                                                                  */
/* -------------------------------------------------------------------------- */

async function migrate(db: Client): Promise<void> {
  await db.execute('CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)');
  const current = Number((await db.execute('SELECT COALESCE(MAX(version), 0) AS v FROM schema_meta')).rows[0]!.v);
  if (current > SCHEMA_VERSION) {
    throw new Error(`The initiative database is from a newer factory (schema ${current}, this one knows ${SCHEMA_VERSION}). Update the factory.`);
  }
  for (let version = current + 1; version <= SCHEMA_VERSION; version += 1) {
    const tx = await db.transaction('write');
    try {
      // `executeMultiple` is not available inside a transaction: split on the statement terminators.
      for (const statement of MIGRATIONS[version - 1]!.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) {
        await tx.execute(statement);
      }
      await tx.execute({ sql: 'DELETE FROM schema_meta', args: [] });
      await tx.execute({ sql: 'INSERT INTO schema_meta (version) VALUES (?)', args: [version] });
      await tx.commit();
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    } finally {
      tx.close();
    }
  }
}

/** Opens (and, the first time, creates) the store. Close it when done. */
export async function openStore(file: string = storeFile()): Promise<InitiativeStore> {
  const known = open.get(file);
  if (known) {
    known.refs += 1;
    return new InitiativeStore(known);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = createClient({ url: `file:${file}` });
  try {
    await db.execute('PRAGMA journal_mode = WAL');
    await db.execute('PRAGMA busy_timeout = 8000');
    await db.execute('PRAGMA foreign_keys = ON');
    await migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  // Another opener may have got there first while this one was migrating.
  const raced = open.get(file);
  if (raced) {
    db.close();
    raced.refs += 1;
    return new InitiativeStore(raced);
  }
  const shared: Shared = { file, db, refs: 1, queue: Promise.resolve() };
  open.set(file, shared);
  return new InitiativeStore(shared);
}

/** Opens the store for the length of `work`. */
export async function withStore<T>(work: (store: InitiativeStore) => Promise<T>, file?: string): Promise<T> {
  const store = await openStore(file);
  try {
    return await work(store);
  } finally {
    store.close();
  }
}
