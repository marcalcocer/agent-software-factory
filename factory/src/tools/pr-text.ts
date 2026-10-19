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
  PrText,
  PrWriterAgentOutput,
  QaReport,
  ReviewReport,
  SecurityReport,
} from '../utils/schemas.ts';
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
  /** The files the change touches, as git sees them (used when the developer report lists none). */
  files: string[];
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

function reviewLine(ctx: PrTextContext): string {
  if (!ctx.pipeline.review) return `Code review: ${NOT_RUN}`;
  return ctx.review ? `Code review: ${ctx.review.status.replace(/_/g, ' ')}` : 'Code review: no result was recorded';
}

function securityLine(ctx: PrTextContext): string {
  if (!ctx.pipeline.security) return `Security audit: ${NOT_RUN}`;
  const security = ctx.security;
  if (!security) return 'Security audit: no result was recorded';
  const risk = security.riskLevel === 'NONE' ? 'no risk found' : `risk ${security.riskLevel.toLowerCase()}`;
  return `Security audit: ${security.status.replace(/_/g, ' ')} (${risk})`;
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
  return ['## Quality gates', '', ...[qaLine(ctx), reviewLine(ctx), securityLine(ctx), documentationLine(ctx)].map((line) => `- ${line}`)].join(
    '\n',
  );
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
  const body = withQualityGates(raw.pullRequest.body, qualityGatesSection(ctx));

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

function changesSection(ctx: PrTextContext): string[] {
  const reported = ctx.developer?.changedFiles ?? [];
  if (reported.length > 0) {
    return bullets(
      reported.map((file) => `\`${file.path}\`${file.purpose.trim() ? ` - ${clipAtWord(file.purpose.trim().replace(/\s+/g, ' '), 140)}` : ''}`),
      MAX_LISTED_FILES,
      ['more file', 'more files'],
    );
  }
  return bullets(ctx.files.map((file) => `\`${file}\``), MAX_LISTED_FILES, ['more file', 'more files']);
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

  const followUps = [...(ctx.developer?.followUps ?? []), ...(ctx.documentation?.followUps ?? [])]
    .map((item) => item.trim())
    .filter(Boolean);

  const sections = [
    ['## Summary', '', summary].join('\n'),
    ['## Changes', '', ...changesSection(ctx)].join('\n'),
    ['## Test plan', '', ...testPlanSection(ctx)].join('\n'),
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
