/**
 * The text a change is published with - its commit message, the pull-request title and the
 * pull-request description - kept free of I/O (no git, no GitHub, no model) so it can be checked on
 * its own.
 *
 * Two sources feed it:
 *   - the PR writer agent, whose answer is cleaned up here (`normalizePrWriterOutput`);
 *   - the factory's own reports, when no agent could answer (`fallbackPrText`).
 *
 * One part is never left to a model: the **Quality gates** section. Which stages ran, and what they
 * found, is something the factory knows for certain, so it writes that section itself
 * (`qualityGatesSection`). A description can therefore never claim a gate that was not run - which is
 * exactly what goes wrong when a stage was switched off and a model fills the gap with what a
 * pull request usually says.
 */
import type {
  DeveloperReport,
  DocumentationReport,
  ExecutionPlan,
  PolishResult,
  PrText,
  PrWriterAgentOutput,
  QaReport,
  ReviewReport,
  SecurityReport,
} from '../utils/schemas.ts';
import type { RoadmapView } from '../initiatives/phasing.ts';
import { cleanBody, cleanSubject, clipAtWord } from './pr-merge-rules.ts';

/* -------------------------------------------------------------------------- */
/* What the writer works from                                                  */
/* -------------------------------------------------------------------------- */

export interface PrTextContext {
  task: string;
  plan: Pick<ExecutionPlan, 'summary' | 'commitMessage' | 'acceptanceCriteria'> | null;
  developer: DeveloperReport | null;
  qa: QaReport | null;
  review: ReviewReport | null;
  security: SecurityReport | null;
  documentation: DocumentationReport | null;
  /** Which optional stages this task runs. A switched-off stage is reported as "not run". */
  pipeline: { qa: boolean; review: boolean; security: boolean; documentation: boolean };
  /** The files the change touches, as git sees them. The developer report only covers the last attempt. */
  files: string[];
  /**
   * What the review and the security audit could not see of the change, per gate: empty when they saw
   * all of it. Their lines say so, instead of presenting a partial look as a full one.
   */
  coverage?: Partial<Record<'review' | 'security', string>>;
  /** What the polish pass did with the minor findings of the gates (`null`: it never ran). */
  polish?: PolishResult | null;
  /** The roadmap this pull request is a phase of (`null`: it is a task of its own). */
  roadmap?: RoadmapView | null;
}

/** The longest commit subject that is ever kept, whoever wrote it. The agent is asked for 72. */
const SUBJECT_LIMIT = 100;
/** The longest pull-request title that is ever kept. */
const TITLE_LIMIT = 120;
const MAX_LABELS = 5;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/* -------------------------------------------------------------------------- */
/* Commit message                                                              */
/* -------------------------------------------------------------------------- */

/** Subject, a blank line, then the body - or just the subject when there is no body. */
export function composeCommitMessage(subject: string, body: string): string {
  const head = clipAtWord(cleanSubject(subject), SUBJECT_LIMIT);
  const rest = cleanBody(body);
  return rest === '' ? head : `${head}\n\n${rest}`;
}

/* -------------------------------------------------------------------------- */
/* Quality gates (written by the factory, never by a model)                    */
/* -------------------------------------------------------------------------- */

const NOT_RUN = 'not run (disabled for this task)';

function qaLine(ctx: PrTextContext): string {
  if (!ctx.pipeline.qa) return `QA: ${NOT_RUN}`;
  const qa = ctx.qa;
  if (!qa) return 'QA: no result was recorded';
  const { tests, passed, failed } = qa.totals;
  const counts =
    tests !== null && passed !== null
      ? ` - ${passed} of ${plural(tests, 'test', 'tests')} passed${failed ? `, ${failed} failed` : ''}`
      : '';
  return `QA: ${qa.verdict}${counts}`;
}

/** " - 25 of 31 changed files seen in full", or nothing when the gate saw the whole change. */
const seen = (note: string | undefined): string => (note ? ` - ${note}` : '');

function reviewLine(ctx: PrTextContext): string {
  if (!ctx.pipeline.review) return `Code review: ${NOT_RUN}`;
  return ctx.review
    ? `Code review: ${ctx.review.status.replace(/_/g, ' ')}${seen(ctx.coverage?.review)}`
    : 'Code review: no result was recorded';
}

function securityLine(ctx: PrTextContext): string {
  if (!ctx.pipeline.security) return `Security audit: ${NOT_RUN}`;
  const security = ctx.security;
  if (!security) return 'Security audit: no result was recorded';
  const risk = security.riskLevel === 'NONE' ? 'no risk found' : `risk ${security.riskLevel.toLowerCase()}`;
  return `Security audit: ${security.status.replace(/_/g, ' ')} (${risk})${seen(ctx.coverage?.security)}`;
}

/** One finding as a line for the reader: where, what, and why it was left. */
function describeFinding(candidate: PolishResult['candidates'][number]): string {
  const where = candidate.file ? `${candidate.file}${candidate.line ? `:${candidate.line}` : ''}` : candidate.source === 'qa' ? 'QA' : 'the change';
  return `${where}: ${clipAtWord(candidate.problem.replace(/\s+/g, ' '), 160)}`;
}

/**
 * What the polish pass means for the pull request: one line for the quality gates, and the findings
 * that were NOT fixed, for the follow-ups. The reviewer approved the code as it was before the polish,
 * so a reader has to be told that something changed after the gates - and what was left.
 */
export function polishNote(result: PolishResult | null | undefined): { line: string; followUps: string[] } | null {
  if (!result) return null;
  const asked = result.candidates.length;
  const byId = new Map(result.candidates.map((candidate) => [candidate.id, candidate]));
  const describe = (id: string): string => (byId.has(id) ? describeFinding(byId.get(id)!) : id);

  const followUps: string[] = [];
  if (result.status === 'APPLIED' || result.status === 'DECLINED') {
    for (const entry of result.declined) followUps.push(`${describe(entry.id)} (not fixed: ${clipAtWord(entry.reason, 120)})`);
    for (const id of result.unanswered) followUps.push(`${describe(id)} (not fixed)`);
  } else {
    // Undone, could not run, or switched off: none of them was fixed, and they must not vanish.
    for (const candidate of result.candidates) followUps.push(`${describeFinding(candidate)} (not fixed)`);
  }
  for (const item of result.reported) {
    if (item.reason !== 'a nit') followUps.push(`${clipAtWord(item.summary.replace(/\s+/g, ' '), 160)} (${item.reason})`);
  }

  let line: string;
  switch (result.status) {
    case 'NONE':
      line = 'Polish: no minor findings to fix';
      break;
    case 'SKIPPED':
      line = result.reason === 'NEEDS_QA' ? 'Polish: not run (it needs the QA stage to check its fixes)' : `Polish: ${NOT_RUN}`;
      break;
    case 'APPLIED':
      line = result.dryRun
        ? `Polish: ${plural(result.applied.length, 'minor finding', 'minor findings')} fixed (dry run)`
        : `Polish: fixed ${result.applied.length} of ${plural(asked, 'minor finding', 'minor findings')} - ` +
          `${plural(result.changedFiles.length, 'file', 'files')} changed after the review, tests and build passed again`;
      break;
    case 'DECLINED':
      line = `Polish: ${plural(asked, 'minor finding', 'minor findings')} looked at, nothing changed`;
      break;
    case 'REVERTED':
      line = `Polish: undone, ${result.detail ?? 'the checks failed'}`;
      break;
    case 'FAILED':
      line = `Polish: could not run (${clipAtWord(result.detail ?? 'unknown reason', 120)})`;
      break;
  }
  return { line, followUps };
}

function documentationLine(ctx: PrTextContext): string {
  if (!ctx.pipeline.documentation) return `Documentation: ${NOT_RUN}`;
  const docs = ctx.documentation;
  if (!docs) return 'Documentation: no result was recorded';
  if (docs.updatedFiles.length > 0) {
    return `Documentation: updated ${plural(docs.updatedFiles.length, 'file', 'files')}`;
  }
  return 'Documentation: checked, no update needed';
}

/**
 * The "Quality gates" section, from the stages' real results. A stage the user switched off says so
 * in plain words; nothing here is a claim a model could get wrong.
 */
export function qualityGatesSection(ctx: PrTextContext): string {
  const polish = polishNote(ctx.polish);
  return [
    '## Quality gates',
    '',
    ...[qaLine(ctx), reviewLine(ctx), securityLine(ctx), ...(polish ? [polish.line] : []), documentationLine(ctx)].map((line) => `- ${line}`),
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Description assembly                                                        */
/* -------------------------------------------------------------------------- */

/** Matches a level-2 heading, with or without the closing hashes, case-insensitively. */
const headingPattern = (name: string): RegExp =>
  new RegExp(`^##\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*#*\\s*$`, 'im');

/** Removes a whole `## <name>` section (up to the next `## ` heading, or the end). */
export function removeSection(body: string, name: string): string {
  const match = headingPattern(name).exec(body);
  if (!match) return body;
  const after = body.slice(match.index + match[0].length);
  const next = after.search(/^##\s/m);
  const tail = next === -1 ? '' : after.slice(next);
  return `${body.slice(0, match.index).trimEnd()}\n\n${tail}`.trim();
}

/**
 * Puts the factory's Quality gates section where reviewers look for it: before "Risks" and
 * "Follow-ups" when the description has them, otherwise at the end. Any such section a model wrote
 * anyway is replaced - the factory's version is the one that is true.
 */
export function withQualityGates(body: string, gates: string): string {
  const clean = removeSection(cleanBody(body), 'Quality gates');
  const tail = /^##\s*(risks?\b|follow-?ups?\b)/im.exec(clean);
  if (!tail) return `${clean}\n\n${gates}`.trim();
  return `${clean.slice(0, tail.index).trimEnd()}\n\n${gates}\n\n${clean.slice(tail.index)}`.trim();
}

/**
 * The "Roadmap" section: which phase this pull request is, and what is left. Written by the factory
 * from the roadmap, never by a model: a reader of one phase has to know it is one phase - the question
 * "is this the only phase?" was asked of a pull request that did not say.
 */
export function roadmapSection(view: RoadmapView): string {
  const lines = view.phases.map((phase) => {
    const title = clipAtWord(phase.title, 100);
    if (phase.status === 'SKIPPED') return `- [ ] ~~${phase.ordinal}. ${title}~~ (skipped)`;
    if (phase.ordinal === view.current) return `- [x] ${phase.ordinal}. ${title} - **this pull request**`;
    return `- [${phase.status === 'MERGED' ? 'x' : ' '}] ${phase.ordinal}. ${title}${phase.status === 'MERGED' ? ' - merged' : ''}`;
  });
  const later = view.phases.filter((phase) => phase.ordinal > view.current && phase.status !== 'SKIPPED' && phase.status !== 'MERGED');
  return [
    '## Roadmap',
    '',
    `This pull request is **phase ${view.current} of ${view.total}** of "${clipAtWord(view.title, 100)}".`,
    '',
    ...lines,
    ...(later.length > 0 ? ['', `Not in this pull request: ${later.length === 1 ? 'phase' : 'phases'} ${later.map((phase) => phase.ordinal).join(', ')}.`] : []),
  ].join('\n');
}

/** Puts the Roadmap section where the quality gates start, replacing any a model wrote anyway. */
export function withRoadmap(body: string, roadmap: RoadmapView | null | undefined): string {
  const clean = removeSection(cleanBody(body), 'Roadmap');
  if (!roadmap) return clean;
  const section = roadmapSection(roadmap);
  const gates = headingPattern('Quality gates').exec(clean);
  const tail = gates ?? /^##\s*(risks?\b|follow-?ups?\b)/im.exec(clean);
  if (!tail) return `${clean}\n\n${section}`.trim();
  return `${clean.slice(0, tail.index).trimEnd()}\n\n${section}\n\n${clean.slice(tail.index)}`.trim();
}

const FOLLOW_UPS_HEADING = /^##\s*follow[- ]?ups?\s*#*\s*$/im;

/**
 * Adds bullets to the "Follow-ups" section of a description, creating it at the end when it has none.
 * The factory knows which minor findings were left unfixed; a description must not depend on the model
 * choosing to mention them. An item the section already holds (the start of its text) is not repeated.
 */
export function withFollowUps(body: string, items: string[]): string {
  const wanted = [...new Set(items.map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const clean = cleanBody(body);
  if (wanted.length === 0) return clean;

  const heading = FOLLOW_UPS_HEADING.exec(clean);
  if (!heading) return `${clean}\n\n## Follow-ups\n\n${wanted.map((item) => `- ${item}`).join('\n')}`.trim();

  const headEnd = heading.index + heading[0].length;
  const after = clean.slice(headEnd);
  const next = after.search(/^##\s/m);
  const section = next === -1 ? after : after.slice(0, next);
  const rest = next === -1 ? '' : after.slice(next);

  const present = section.toLowerCase().replace(/\s+/g, ' ');
  const fresh = wanted.filter((item) => !present.includes(item.toLowerCase().slice(0, 60)));
  if (fresh.length === 0) return clean;

  const grown = `${clean.slice(0, headEnd)}${section.trimEnd()}\n${fresh.map((item) => `- ${item}`).join('\n')}`;
  return (rest === '' ? grown : `${grown}\n\n${rest}`).trim();
}

/** Labels the way GitHub wants them: trimmed, unique, not empty, and not a pile of them. */
export function cleanLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of labels) {
    const label = raw.replace(/\s+/g, ' ').trim();
    if (label === '' || label.length > 50 || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    kept.push(label);
    if (kept.length === MAX_LABELS) break;
  }
  return kept;
}

/**
 * Puts the PR writer's answer into its final shape: a clean one-line subject, a title that is never
 * empty, and a description whose Quality gates section is the factory's own.
 */
export function normalizePrWriterOutput(raw: PrWriterAgentOutput, ctx: PrTextContext): PrText {
  const subject = clipAtWord(cleanSubject(raw.commitMessage.subject), SUBJECT_LIMIT);
  const fallbackSubject = clipAtWord(cleanSubject(ctx.plan?.commitMessage ?? ''), SUBJECT_LIMIT) || clipAtWord(cleanSubject(ctx.task), 72);
  const commitSubject = subject === '' ? fallbackSubject : subject;

  const title = clipAtWord(cleanSubject(raw.pullRequest.title), TITLE_LIMIT) || commitSubject;
  const body = withFollowUps(
    withRoadmap(withQualityGates(raw.pullRequest.body, qualityGatesSection(ctx)), ctx.roadmap),
    polishNote(ctx.polish)?.followUps ?? [],
  );

  return {
    commitMessage: composeCommitMessage(commitSubject, raw.commitMessage.body),
    pullRequest: {
      title,
      body,
      labels: cleanLabels(raw.pullRequest.labels),
      breakingChanges: raw.pullRequest.breakingChanges,
    },
    source: 'agent',
  };
}

/* -------------------------------------------------------------------------- */
/* The fallback: the same text, from the reports alone                         */
/* -------------------------------------------------------------------------- */

const MAX_LISTED_FILES = 12;
const MAX_LISTED_COMMANDS = 4;

/** `- <item>` lines, with a closing "and N more" when the list was cut. */
function bullets(items: string[], max: number, noun: [string, string]): string[] {
  const shown = items.slice(0, max).map((item) => `- ${item}`);
  const hidden = items.length - shown.length;
  return hidden > 0 ? [...shown, `- and ${plural(hidden, noun[0], noun[1])}`] : shown;
}

/**
 * The files of the change. Git is the truth about *which* files: the developer report belongs to the
 * last attempt only, so after a retry it lists just what that retry touched (3 files of 22, in a real
 * run). The report is used for *why* - the purpose of each file it does mention - and as the list only
 * when git's is not available.
 */
function changesSection(ctx: PrTextContext): string[] {
  const reported = ctx.developer?.changedFiles ?? [];
  const purposes = new Map(reported.map((file) => [file.path, file.purpose.trim().replace(/\s+/g, ' ')]));
  const paths = ctx.files.length > 0 ? ctx.files : reported.map((file) => file.path);

  return bullets(
    paths.map((path) => {
      const purpose = purposes.get(path);
      return `\`${path}\`${purpose ? ` - ${clipAtWord(purpose, 140)}` : ''}`;
    }),
    MAX_LISTED_FILES,
    ['more file', 'more files'],
  );
}

function testPlanSection(ctx: PrTextContext): string[] {
  if (!ctx.pipeline.qa) return ['- Not run: the QA stage was disabled for this task.'];
  const commands = ctx.qa?.executedCommands ?? [];
  if (commands.length === 0) return ['- No command was recorded.'];
  return bullets(
    commands.map((command) => `\`${clipAtWord(command.command, 120)}\` - exit code ${command.exitCode}`),
    MAX_LISTED_COMMANDS,
    ['more command', 'more commands'],
  );
}

/**
 * A plain description built from what the run recorded, for when no agent could write one. It reads
 * like a normal pull-request description - it is what the human sees, and edits, at the delivery
 * gate - and says nothing it cannot back.
 */
export function fallbackPrText(ctx: PrTextContext, reason?: string): PrText {
  const subject =
    clipAtWord(cleanSubject(ctx.plan?.commitMessage ?? ''), SUBJECT_LIMIT) || clipAtWord(cleanSubject(ctx.task), 72) || 'Update';

  const summary = clipAtWord(
    (ctx.developer?.summary?.trim() || ctx.plan?.summary?.trim() || ctx.task.trim()).replace(/\s*\n\s*/g, ' '),
    700,
  );

  const followUps = [
    ...(ctx.developer?.followUps ?? []),
    ...(ctx.documentation?.followUps ?? []),
    ...(polishNote(ctx.polish)?.followUps ?? []),
  ]
    .map((item) => item.trim())
    .filter(Boolean);

  const sections = [
    ['## Summary', '', summary].join('\n'),
    ['## Changes', '', ...changesSection(ctx)].join('\n'),
    ['## Test plan', '', ...testPlanSection(ctx)].join('\n'),
    ...(ctx.roadmap ? [roadmapSection(ctx.roadmap)] : []),
    qualityGatesSection(ctx),
    ...(followUps.length > 0 ? [['## Follow-ups', '', ...bullets(followUps, 6, ['more item', 'more items'])].join('\n')] : []),
  ];

  return {
    commitMessage: composeCommitMessage(subject, ''),
    pullRequest: { title: subject, body: sections.join('\n\n'), labels: [], breakingChanges: false },
    source: 'fallback',
    ...(reason ? { note: reason } : {}),
  };
}
