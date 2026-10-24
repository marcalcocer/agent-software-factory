/**
 * Free-tier evaluation: what a candidate model has to get right to be trusted with a small role.
 *
 * Pure parts of `npm run eval:free` (the sample requests, the checks, the table), kept apart from the
 * command so they can be tested without calling a model. Nothing here is used by a run.
 */
import type { z } from 'zod';

import { mergeSummarySchema, prWriterAgentSchema, runNameSchema } from './schemas.ts';
import type { AgentRole } from './model-router.ts';

export type EvalRole = Extract<AgentRole, 'run-namer' | 'merge-summary' | 'pr-writer'>;

export interface EvalCase {
  role: EvalRole;
  id: string;
  prompt: string;
  schema: z.ZodType;
}

export type EvalOutcome = 'ok' | 'invalid' | 'rate-limit' | 'auth' | 'error';

export interface EvalResult {
  model: string;
  role: EvalRole;
  caseId: string;
  outcome: EvalOutcome;
  /** Contract met but a house rule broken (a subject over 72 characters, a final full stop...). */
  issues: string[];
  durationMs: number;
  error?: string;
}

const DIFF_CACHE = `diff --git a/src/cache.ts b/src/cache.ts
--- a/src/cache.ts
+++ b/src/cache.ts
@@ -1,9 +1,18 @@
-const store = new Map<string, string>();
+const store = new Map<string, { value: string; expiresAt: number }>();
+const TTL_MS = 60_000;
 
 export function get(key: string): string | undefined {
-  return store.get(key);
+  const entry = store.get(key);
+  if (!entry) return undefined;
+  if (entry.expiresAt < Date.now()) {
+    store.delete(key);
+    return undefined;
+  }
+  return entry.value;
 }
 
 export function set(key: string, value: string): void {
-  store.set(key, value);
+  store.set(key, { value, expiresAt: Date.now() + TTL_MS });
 }
diff --git a/test/cache.test.ts b/test/cache.test.ts
--- a/test/cache.test.ts
+++ b/test/cache.test.ts
@@ -1,4 +1,10 @@
+it('drops an entry after its time to live', () => {
+  set('a', '1');
+  vi.advanceTimersByTime(61_000);
+  expect(get('a')).toBeUndefined();
+});
`;

const DIFF_LOGIN = `diff --git a/src/login.ts b/src/login.ts
--- a/src/login.ts
+++ b/src/login.ts
@@ -12,7 +12,10 @@ export async function login(email: string, password: string) {
-  const user = await db.users.findOne({ email });
-  if (user.password === password) return issueToken(user);
+  const user = await db.users.findOne({ email: email.trim().toLowerCase() });
+  if (!user) throw new AuthError('unknown user');
+  if (await verifyHash(password, user.passwordHash)) return issueToken(user);
   throw new AuthError('bad credentials');
 }
`;

const NAMER_TASKS = [
  'I want to add a dark mode to every screen of the app, with a switch in the settings and the choice remembered between sessions.',
  'The export to CSV drops the last row when the table has more than 1000 rows. Find out why and fix it.',
  'Please upgrade the build from webpack 4 to vite, keeping the same output folder and the same environment variables.',
];

/** The sample requests. Written for this check: the fixtures hold what the agents answered, not what they were asked. */
export function buildEvalCases(): EvalCase[] {
  const cases: EvalCase[] = NAMER_TASKS.map((task, index) => ({
    role: 'run-namer',
    id: `namer-${index + 1}`,
    prompt: `# Request to name\n\n${task}\n\nName this task: a title, a slug and a type.`,
    schema: runNameSchema,
  }));

  const merges = [
    ['cache-ttl', 'Entries of the cache expire after a minute', DIFF_CACHE],
    ['login-hash', 'Login compares password hashes and normalises the email', DIFF_LOGIN],
  ] as const;
  for (const [id, title, diff] of merges) {
    cases.push({
      role: 'merge-summary',
      id: `merge-${id}`,
      prompt:
        `# Pull request\n\nTitle: ${title}\n\n# Diff\n\n\`\`\`diff\n${diff}\`\`\`\n\n` +
        'Write the commit message of the squash merge: a subject and a body.',
      schema: mergeSummarySchema,
    });
    cases.push({
      role: 'pr-writer',
      id: `pr-${id}`,
      prompt:
        `# Task\n\n${title}.\n\n# Quality gates\n\nQA: passed. Code review: approved. Security: no findings.\n\n` +
        `# Final diff\n\n\`\`\`diff\n${diff}\`\`\`\n\nWrite the commit message and the pull-request text.`,
      schema: prWriterAgentSchema,
    });
  }
  return cases;
}

const endsWithStop = (text: string): boolean => /[.!?]\s*$/.test(text.trim());

/** House rules a valid answer can still break. An empty list means the answer could be used as it is. */
export function qualityIssues(role: EvalRole, object: unknown): string[] {
  const issues: string[] = [];
  const o = (object ?? {}) as Record<string, any>;
  const subjectRules = (subject: unknown, label: string, max: number) => {
    const text = typeof subject === 'string' ? subject : '';
    if (text.length > max) issues.push(`${label} over ${max} characters`);
    if (endsWithStop(text)) issues.push(`${label} ends with a full stop`);
    if (text.includes('(#')) issues.push(`${label} holds a pull-request reference`);
  };
  if (role === 'run-namer') {
    if (typeof o.title === 'string' && o.title.length >= 60) issues.push('title is 60 characters or more');
    if (typeof o.title === 'string' && endsWithStop(o.title)) issues.push('title ends with a full stop');
    if (!/^[a-z0-9]+(-[a-z0-9]+){2,4}$/.test(String(o.slug ?? ''))) issues.push('slug is not 3-5 lowercase words');
  } else if (role === 'merge-summary') {
    subjectRules(o.subject, 'subject', 72);
  } else {
    subjectRules(o.commitMessage?.subject, 'commit subject', 72);
    if (typeof o.pullRequest?.title === 'string' && o.pullRequest.title.length > 72) issues.push('pull-request title over 72 characters');
    if (!/summary/i.test(String(o.pullRequest?.body ?? ''))) issues.push('pull-request body has no Summary');
  }
  return issues;
}

/** Sorts a failure into what the next step should be: wait, fix a key, or look at the model. */
export function classifyError(message: string): Extract<EvalOutcome, 'invalid' | 'rate-limit' | 'auth' | 'error'> {
  if (/\b429\b|rate.?limit|quota|resource_exhausted|too many requests/i.test(message)) return 'rate-limit';
  if (/\b40[13]\b|api key|unauthori[sz]ed|permission|forbidden|invalid.*key/i.test(message)) return 'auth';
  if (/structured|schema|validation|no structured output|json|zod/i.test(message)) return 'invalid';
  return 'error';
}

export interface EvalRow {
  model: string;
  role: EvalRole;
  runs: number;
  valid: number;
  clean: number;
  rateLimited: number;
  failed: number;
  avgMs: number;
}

/** One row per model and role. */
export function summarize(results: EvalResult[]): EvalRow[] {
  const rows = new Map<string, EvalRow & { totalMs: number }>();
  for (const result of results) {
    const key = `${result.model}\u0000${result.role}`;
    const row =
      rows.get(key) ??
      { model: result.model, role: result.role, runs: 0, valid: 0, clean: 0, rateLimited: 0, failed: 0, avgMs: 0, totalMs: 0 };
    row.runs += 1;
    row.totalMs += result.durationMs;
    if (result.outcome === 'ok') {
      row.valid += 1;
      if (result.issues.length === 0) row.clean += 1;
    } else if (result.outcome === 'rate-limit') row.rateLimited += 1;
    else row.failed += 1;
    rows.set(key, row);
  }
  return [...rows.values()].map(({ totalMs, ...row }) => ({ ...row, avgMs: row.runs === 0 ? 0 : Math.round(totalMs / row.runs) }));
}

/** The table the user pastes back. `valid` meets the contract; `clean` also keeps the house rules. */
export function renderTable(rows: EvalRow[]): string {
  const header = ['model', 'role', 'valid', 'clean', 'rate-limited', 'failed', 'avg time'];
  const body = rows.map((r) => [r.model, r.role, `${r.valid}/${r.runs}`, `${r.clean}/${r.runs}`, String(r.rateLimited), String(r.failed), `${(r.avgMs / 1000).toFixed(1)}s`]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((line) => line[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}
