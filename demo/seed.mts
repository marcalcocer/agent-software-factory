/**
 * Seeds the factory demo with a scenario that needs no model. Run by demo/setup.sh (never by hand: it needs the
 * environment of demo/env.sh).
 *
 * What it builds, with the factory's own functions so every record is in the format the real code writes:
 *
 *   - a PROJECT, "Redesign the frontend", of four phases. Phase 1 (design tokens and dark mode) is task f0001: a
 *     real git worktree with two real commits (a first run and a round that answered review), pushed to the demo's
 *     origin, with pull request #8 under review - the run records are the real ones of the UI refactor this
 *     repository's fixtures hold (a first run and its second round), re-pointed at this world.
 *   - the reviewer's four comments on #8, and the triage of them: a defect, a request for phase 2, a request no
 *     phase covers, and a question. So #8 opens in "Choose where it goes".
 *   - a plain TASK, f0002 (a percent formatter): its own worktree, pull request #9, and a triage that is only
 *     questions to answer.
 *   - a second plain task, f0003 (a changelog): pull request #10 with nothing to answer - the one to approve and
 *     merge, or to close or merge "on GitHub" with demo-review.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { roadmapView } from '../factory/src/initiatives/phasing.ts';
import { withStore } from '../factory/src/initiatives/store.ts';
import { createRunTrace, generateRunId, writeArtifact, writeSummary } from '../factory/src/tools/logger-tools.ts';
import { registerPullRequest } from '../factory/src/tools/pr-registry.ts';
import { withRoadmap } from '../factory/src/tools/pr-text.ts';
import { roundTitle } from '../factory/src/tools/run-naming.ts';
import { ensureWorktree } from '../factory/src/tools/worktree.ts';
import { allocateTaskId } from '../factory/src/utils/task-ids.ts';

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: run this through demo/setup.sh`);
  return value;
};
const ROOT = need('DEMO_ROOT');
const DEMO = need('DEMO_DIR');
const LOGS = need('FACTORY_LOG_DIR');
const REPO = path.join(need('FACTORY_WORKSPACE_ROOT'), 'demo-app');
const FIXTURES = path.join(ROOT, 'fixtures', 'runs');
const GH = path.join(ROOT, 'demo', 'bin', 'gh');
const REVIEW = path.join(ROOT, 'demo', 'bin', 'demo-review');

const sh = (file: string, args: string[], cwd = REPO): string =>
  execFileSync(file, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const git = (cwd: string, ...args: string[]): string => sh('git', args, cwd);

/** Writes files into a checkout and commits them. */
function commit(tree: string, files: Record<string, string>, message: string): void {
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tree, relative)), { recursive: true });
    fs.writeFileSync(path.join(tree, relative), content);
  }
  git(tree, 'add', '-A');
  git(tree, 'commit', '-q', '-m', message);
}

/** Opens a pull request on the pretend GitHub, the way the factory's delivery step does. */
function openPullRequest(tree: string, branch: string, title: string, body: string): { number: number; url: string } {
  const bodyFile = path.join(os.tmpdir(), `demo-pr-body-${process.pid}.md`);
  fs.writeFileSync(bodyFile, body);
  const url = sh(GH, ['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body-file', bodyFile], tree);
  fs.rmSync(bodyFile, { force: true });
  return { number: Number(/\/pull\/(\d+)/.exec(url)![1]), url };
}

/** A copy of a real run directory of the fixtures, made to belong to this world. */
function copyRun(fromId: string, toId: string, rewrite: Array<[string, string]>, patch: (meta: Record<string, any>, summary: Record<string, any>) => void): void {
  const from = path.join(FIXTURES, fromId);
  const to = path.join(LOGS, toId);
  fs.cpSync(from, to, { recursive: true });
  for (const name of fs.readdirSync(to)) {
    const file = path.join(to, name);
    if (!fs.statSync(file).isFile()) continue;
    let text = fs.readFileSync(file, 'utf8');
    for (const [before, after] of rewrite) text = text.split(before).join(after);
    fs.writeFileSync(file, text);
  }
  const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(to, name), 'utf8')) as Record<string, any>;
  const meta = readJson('run.json');
  const summary = readJson('summary.json');
  patch(meta, summary);
  fs.writeFileSync(path.join(to, 'run.json'), `${JSON.stringify(meta, null, 2)}\n`);
  fs.writeFileSync(path.join(to, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

/** The result of a triage of a pull request's comments, as the factory leaves it. */
function writeTriage(input: {
  pullRequest: { number: number; url: string };
  branch: string;
  action: 'RERUN_IMPLEMENTATION' | 'REPLY_ONLY';
  summary: string;
  followUpTask?: string;
  roundTitle?: string;
  items: Array<Record<string, any>>;
  comments: Array<Record<string, any>>;
}): string {
  const runId = generateRunId('demo-app-prfeedback');
  const startedAt = new Date(Date.now() - 45_000).toISOString();
  createRunTrace({
    runId, task: `PR feedback triage for #${input.pullRequest.number}`, repoPath: REPO, repoName: 'demo-app', branch: input.branch, baseBranch: 'main',
    models: {}, kind: 'pr-feedback', dryRun: false, startedAt,
  });
  writeArtifact({ runId, step: 'feedback-triage', status: input.action, data: { overallAction: input.action, summary: input.summary, items: input.items } });
  writeSummary(runId, {
    runId, kind: 'pr-feedback', repository: REPO, pullRequest: input.pullRequest.number, pullRequestUrl: input.pullRequest.url, branch: input.branch,
    baseBranch: 'main', status: input.action, summary: input.summary, commentsTriaged: input.items.length, repliesPosted: 0,
    followUpTask: input.followUpTask ?? '', ...(input.roundTitle ? { roundTitle: input.roundTitle } : {}), blockers: [], items: input.items,
    comments: input.comments, finishedAt: new Date().toISOString(),
  });
  return runId;
}

/* ========================================================================== */
/* The code                                                                    */
/* ========================================================================== */

const THEME_JS = `/** The colour tokens of the design system, light and dark. */
export const tokens = {
  light: { background: '#ffffff', foreground: '#0f172a', muted: '#64748b', card: '#f8fafc' },
  dark: { background: '#0b1220', foreground: '#e2e8f0', muted: '#94a3b8', card: '#111a2e' },
};

/** The tokens of a theme; an unknown name gets the light one. */
export function themeFor(name) {
  return tokens[name] ?? tokens.light;
}

/** The theme as CSS custom properties: "--background: #ffffff; ...". */
export function cssVariables(name) {
  return Object.entries(themeFor(name))
    .map(([key, value]) => \`--\${key}: \${value};\`)
    .join(' ');
}
`;

const t1 = await allocateTaskId();
const t2 = await allocateTaskId();
const t3 = await allocateTaskId();
const branch1 = `factory/${t1}/feat-design-tokens-dark-mode`;
const branch2 = `factory/${t2}/feat-percent-formatter`;
const branch3 = `factory/${t3}/docs-changelog`;

/* ---- phase 1: the first run, then the round that answered review ---- */
const tree1 = await ensureWorktree({ mainRepoPath: REPO, taskId: t1, branch: branch1, baseBranch: 'main', freshStart: true, dependencyDirs: ['ui'] });
commit(
  tree1.path,
  {
    'ui/src/lib/cn.js': "/** Joins class names, leaving out what is empty. */\nexport const cn = (...parts) => parts.filter(Boolean).join(' ');\n",
    'ui/src/lib/theme.js': THEME_JS,
    'ui/src/index.js': "export { cn } from './lib/cn.js';\nexport { money } from './lib/format.js';\nexport { cssVariables, themeFor, tokens } from './lib/theme.js';\nexport { investmentPage } from './pages/investment.js';\nexport { settingsPage } from './pages/settings.js';\n",
    'ui/test/theme.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cn } from '../src/lib/cn.js';
import { cssVariables, themeFor } from '../src/lib/theme.js';

test('an unknown theme falls back to the light one', () => {
  assert.equal(themeFor('sepia').background, '#ffffff');
});

test('the dark theme has its own background', () => {
  assert.equal(themeFor('dark').background, '#0b1220');
});

test('cssVariables lists every token as a custom property', () => {
  assert.match(cssVariables('light'), /--background: #ffffff;/);
});

test('cn leaves out what is empty', () => {
  assert.equal(cn('a', '', null, 'b'), 'a b');
});
`,
  },
  `feat(ui): add design tokens and a dark theme\n\nAdd the colour tokens of the design system, light and dark, a helper that lists them as CSS custom\nproperties, and a class-name joiner. Nothing uses them yet: that is the next phase of the roadmap.\n\nFactory-Task: ${t1}`,
);
commit(
  tree1.path,
  {
    'ui/src/pages/investment.js': 'export function investmentPage(name = \'Savings\') {\n  return `<main class="bg-background text-foreground"><h1>Investment: ${name}</h1></main>`;\n}\n',
    'ui/test/pages.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';

import { investmentPage } from '../src/pages/investment.js';
import { settingsPage } from '../src/pages/settings.js';

test('the investment page names the investment', () => {
  assert.match(investmentPage('Savings'), /Investment: Savings/);
});

test('the investment page uses the design tokens, not fixed colours', () => {
  assert.doesNotMatch(investmentPage(), /bg-white|text-slate/);
  assert.match(investmentPage(), /bg-background text-foreground/);
});

test('the settings page has a title', () => {
  assert.match(settingsPage(), /<h1>Settings<\\/h1>/);
});
`,
  },
  `chore: finish dark mode on the investment page\n\nThe investment page uses the design tokens instead of fixed light colours.\n\nFactory-Task: ${t1}`,
);
git(tree1.path, 'push', '-q', '-u', 'origin', branch1);

/* ---- the plain task ---- */
const tree2 = await ensureWorktree({ mainRepoPath: REPO, taskId: t2, branch: branch2, baseBranch: 'main', freshStart: true, dependencyDirs: ['ui'] });
commit(
  tree2.path,
  {
    'ui/src/lib/format.js': `/** Formats an amount of money: 1234.5 -> "$1,234.50". */
export function money(amount) {
  return \`$\${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\`;
}

/** Formats a ratio as a percentage: 0.1234 -> "12.34%". */
export function percent(ratio) {
  return \`\${(Number(ratio) * 100).toFixed(2)}%\`;
}
`,
    'ui/src/index.js': "export { money, percent } from './lib/format.js';\nexport { investmentPage } from './pages/investment.js';\nexport { settingsPage } from './pages/settings.js';\n",
    'ui/test/format.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';

import { money, percent } from '../src/lib/format.js';

test('money groups thousands and keeps two decimals', () => {
  assert.equal(money(1234.5), '$1,234.50');
});

test('percent shows a ratio with two decimals', () => {
  assert.equal(percent(0.1234), '12.34%');
});
`,
  },
  `feat(ui): add a percent formatter\n\nA ratio shown as a percentage with two decimals, next to money().\n\nFactory-Task: ${t2}`,
);
git(tree2.path, 'push', '-q', '-u', 'origin', branch2);

/* ---- a second plain task: nothing to answer ---- */
const tree3 = await ensureWorktree({ mainRepoPath: REPO, taskId: t3, branch: branch3, baseBranch: 'main', freshStart: true, dependencyDirs: ['ui'] });
commit(
  tree3.path,
  { 'CHANGELOG.md': '# Changelog\n\n## Unreleased\n\n- Colour tokens and a dark theme (in review).\n- A percent formatter (in review).\n' },
  `docs: add a changelog\n\nA place to say what changed, starting with what is in review.\n\nFactory-Task: ${t3}`,
);
git(tree3.path, 'push', '-q', '-u', 'origin', branch3);

/* ========================================================================== */
/* The project and its pull requests                                           */
/* ========================================================================== */

const PROJECT_TITLE = 'Redesign the frontend';
const PHASE_TITLES = ['Design tokens and dark mode', 'Screens', 'Charts and graphs', 'Cleanup and documentation'];

const project = await withStore(async (store) => {
  const created = await store.createInitiative({
    repoPath: REPO, title: PROJECT_TITLE, goal: 'Give the investment app a professional, modern interface: a design system, dark mode, redesigned screens and charts.',
    firstPhase: { title: PHASE_TITLES[0]! },
  });
  await store.linkRun(created.phases[0]!.id, { taskId: t1, rootRunId: 'pending', branch: branch1 });
  const set = await store.setRoadmap(created.id, {
    title: PROJECT_TITLE,
    phases: [
      {
        title: PHASE_TITLES[0]!, goal: 'A design system with light and dark tokens, used by the investment page.',
        scope: ['Colour tokens for light and dark', 'A helper that lists them as CSS custom properties', 'The investment page uses the tokens'],
        acceptance: ['The tokens exist and are tested', 'The investment page renders without fixed colours'],
      },
      { title: PHASE_TITLES[1]!, goal: 'Every screen uses the tokens.', scope: ['The settings page', 'The home and list pages', 'All modals and forms'], acceptance: ['No screen has a fixed light colour'] },
      { title: PHASE_TITLES[2]!, goal: 'Charts follow the theme.', scope: ['Theme-aware chart colours', 'Zoom and pan on every chart'] },
      { title: PHASE_TITLES[3]!, goal: 'Remove what the redesign replaced, and document it.', scope: ['Delete the old styles', 'Document the design system in the README'] },
    ],
  });
  await store.addBacklog(set.id, [
    { source: 'qa', text: 'The chart toolbar icon colours use the chart library defaults and may need a CSS override for contrast in dark mode.', severity: 'MINOR' },
    { source: 'review', text: 'The yellow Edit button on the details list has no token: it still uses a fixed colour.', severity: 'MINOR' },
    { source: 'developer', text: 'The font stack names Inter but it is not loaded: decide whether to self-host it.', severity: 'INFO' },
  ]);
  return (await store.getInitiative(set.id))!;
});
const phase1 = project.phases[0]!;

const plain = await withStore(async (store) => {
  const created = await store.createInitiative({
    repoPath: REPO, title: 'Add a percent formatter', goal: 'Add a percent(ratio) formatter next to money(), with a test.', kind: 'quick',
    firstPhase: { title: 'Add a percent formatter' },
  });
  return created;
});

// The first run's pull-request text is the real one of the UI refactor, with the roadmap section the factory adds.
const written = JSON.parse(fs.readFileSync(path.join(FIXTURES, '20261019-171016-invest-track-61e6', '07-pr-writer.attempt-2.json'), 'utf8')).data.pullRequest as { title: string; body: string };
const title1 = written.title;
const body1 = withRoadmap(written.body.replace(/invest-track/g, 'demo-app'), roadmapView(project, phase1.id));
const pr1 = openPullRequest(tree1.path, branch1, title1, body1);
const title2 = 'feat(ui): add a percent formatter';
const pr2 = openPullRequest(
  tree2.path, branch2, title2,
  '## Summary\nAdds `percent(ratio)` next to `money()`: a ratio shown as a percentage with two decimals.\n\n## Changes\n- `ui/src/lib/format.js`: `percent()`.\n- `ui/src/index.js`: exports it.\n- `ui/test/format.test.js`: a test.\n\n## Quality gates\n\n- QA: PASS - 2 of 2 tests passed\n- Code review: APPROVED\n- Security audit: PASS\n',
);

const plain3 = await withStore(async (store) => {
  return await store.createInitiative({
    repoPath: REPO, title: 'Add a changelog', goal: 'Add a CHANGELOG.md, starting with what is in review.', kind: 'quick', firstPhase: { title: 'Add a changelog' },
  });
});
const title3 = 'docs: add a changelog';
const pr3 = openPullRequest(
  tree3.path, branch3, title3,
  '## Summary\nAdds a `CHANGELOG.md`, starting with what is in review.\n\n## Changes\n- `CHANGELOG.md`: new.\n\n## Quality gates\n\n- QA: PASS - 3 of 3 tests passed\n- Code review: APPROVED\n- Security audit: PASS\n',
);

/* ---- the run records: the real runs of the fixtures, made to belong here ---- */
const R1 = '20261019-171016-demo-app-61e6';
const R2 = '20261019-173458-demo-app-c0u4';
const R3 = '20261014-182545-demo-app-hby1';
const REWRITE: Array<[string, string]> = [['/home/dev/workspace/invest-track', REPO], ['marcalcocer/invest-track', 'demo/demo-app'], ['invest-track', 'demo-app']];

copyRun('20261019-171016-invest-track-61e6', R1, REWRITE, (meta, summary) => {
  Object.assign(meta, {
    taskId: t1, title: PHASE_TITLES[0], titleSource: 'agent', branch: branch1, baseBranch: 'main', isolation: 'worktree', workPath: tree1.path,
    initiativeId: project.id, phaseId: phase1.id, dryRun: false,
  });
  Object.assign(summary, { taskId: t1, title: PHASE_TITLES[0], branch: branch1, repository: REPO, initiativeId: project.id, phaseId: phase1.id, pullRequestUrl: pr1.url, dryRun: false });
});
copyRun('20261019-173458-invest-track-c0u4', R2, REWRITE, (meta, summary) => {
  const focus = 'Finish dark mode on the investment pages';
  Object.assign(meta, {
    taskId: t1, title: roundTitle(PHASE_TITLES[0]!, 2, focus), titleSource: 'round', branch: branch1, baseBranch: 'main', isolation: 'worktree', workPath: tree1.path,
    initiativeId: project.id, phaseId: phase1.id, rootRunId: R1, parentRunId: R1, round: 2, dryRun: false,
    pullRequest: { number: pr1.number, url: pr1.url, headBranch: branch1, baseBranch: 'main' },
  });
  Object.assign(summary, { taskId: t1, title: roundTitle(PHASE_TITLES[0]!, 2, focus), branch: branch1, repository: REPO, initiativeId: project.id, phaseId: phase1.id, rootRunId: R1, parentRunId: R1, round: 2, pullRequestUrl: pr1.url, dryRun: false });
});
const smokeMeta = JSON.parse(fs.readFileSync(path.join(FIXTURES, '20261014-182545-smoke-happy-hby1', 'run.json'), 'utf8')) as Record<string, any>;
copyRun('20261014-182545-smoke-happy-hby1', R3, [[String(smokeMeta.repoPath), REPO], ['20261014-182545-smoke-happy-hby1', R3], [String(smokeMeta.repoName), 'demo-app']], (meta, summary) => {
  const task = 'Add a percent(ratio) formatter next to money(), with a test.';
  Object.assign(meta, {
    task, repoPath: REPO, repoName: 'demo-app', taskId: t2, title: 'Add a percent formatter', titleSource: 'agent', branch: branch2, baseBranch: 'main', isolation: 'worktree', workPath: tree2.path,
    initiativeId: plain.id, phaseId: plain.phases[0]!.id, dryRun: false,
  });
  Object.assign(summary, {
    task, status: 'DELIVERED', repository: REPO, taskId: t2, title: 'Add a percent formatter', branch: branch2, initiativeId: plain.id, phaseId: plain.phases[0]!.id,
    pullRequestUrl: pr2.url, dryRun: false,
  });
});

const R4 = '20261014-182546-demo-app-tz77';
const reviewMeta = JSON.parse(fs.readFileSync(path.join(FIXTURES, '20261014-182546-smoke-review-changes-tz77', 'run.json'), 'utf8')) as Record<string, any>;
copyRun('20261014-182546-smoke-review-changes-tz77', R4, [[String(reviewMeta.repoPath), REPO], ['20261014-182546-smoke-review-changes-tz77', R4], [String(reviewMeta.repoName), 'demo-app']], (meta, summary) => {
  const task = 'Add a CHANGELOG.md, starting with what is in review.';
  Object.assign(meta, {
    task, repoPath: REPO, repoName: 'demo-app', taskId: t3, title: 'Add a changelog', titleSource: 'agent', branch: branch3, baseBranch: 'main', isolation: 'worktree', workPath: tree3.path,
    initiativeId: plain3.id, phaseId: plain3.phases[0]!.id, dryRun: false,
  });
  Object.assign(summary, {
    task, status: 'DELIVERED', repository: REPO, taskId: t3, title: 'Add a changelog', branch: branch3, initiativeId: plain3.id, phaseId: plain3.phases[0]!.id,
    pullRequestUrl: pr3.url, dryRun: false,
  });
});

/* ---- link the pull requests, and start watching them ---- */
await withStore(async (store) => {
  await store.linkRun(phase1.id, { taskId: t1, rootRunId: R1, branch: branch1 });
  await store.linkPullRequest(phase1.id, { number: pr1.number, url: pr1.url, branch: branch1 });
  await store.linkRun(plain.phases[0]!.id, { taskId: t2, rootRunId: R3, branch: branch2 });
  await store.linkPullRequest(plain.phases[0]!.id, { number: pr2.number, url: pr2.url, branch: branch2 });
  await store.linkRun(plain3.phases[0]!.id, { taskId: t3, rootRunId: R4, branch: branch3 });
  await store.linkPullRequest(plain3.phases[0]!.id, { number: pr3.number, url: pr3.url, branch: branch3 });
});
const watchSince = new Date(Date.now() - 3_600_000).toISOString(); // what is said from now on counts as new
await registerPullRequest({ repoPath: REPO, number: pr1.number, url: pr1.url, title: title1, headBranch: branch1, baseBranch: 'main', runId: R2, rootRunId: R1, round: 2, watchSince });
await registerPullRequest({ repoPath: REPO, number: pr2.number, url: pr2.url, title: title2, headBranch: branch2, baseBranch: 'main', runId: R3, watchSince });
await registerPullRequest({ repoPath: REPO, number: pr3.number, url: pr3.url, title: title3, headBranch: branch3, baseBranch: 'main', runId: R4, watchSince });

/* ========================================================================== */
/* The reviewer, and the triage of what they said                              */
/* ========================================================================== */

const themeLine = fs.readFileSync(path.join(tree1.path, 'ui/src/lib/theme.js'), 'utf8').split('\n').findIndex((line) => line.includes('return tokens[name]')) + 1;
const SAY = {
  defect: 'themeFor returns the shared tokens object itself: a caller that changes the result changes the theme for everyone. Please return a copy.',
  settings: 'Make the settings page dark too. It still has white cards.',
  shortcut: 'Could you add a keyboard shortcut to toggle the theme? Something like Ctrl+Shift+L.',
  question: "Why CSS custom properties, instead of Tailwind's dark: variants?",
};
sh(REVIEW, ['thread', String(pr1.number), 'ui/src/lib/theme.js', String(themeLine), SAY.defect]);
sh(REVIEW, ['comment', String(pr1.number), SAY.settings]);
sh(REVIEW, ['comment', String(pr1.number), SAY.shortcut]);
sh(REVIEW, ['comment', String(pr1.number), SAY.question]);
sh(REVIEW, ['comment', String(pr2.number), 'Why two decimals and not one?']);
sh(REVIEW, ['comment', String(pr2.number), 'Nice tests, thanks!']);

const github = JSON.parse(fs.readFileSync(path.join(DEMO, 'gh-state.json'), 'utf8')) as { prs: Record<string, any> };
const conversation = (number: number, text: string) => github.prs[String(number)].comments.find((c: any) => c.body === text);
const thread = github.prs[String(pr1.number)].threads[0];
const threadComment = thread.comments[0];
const fromConversation = (c: any) => ({ id: c.id, source: 'ISSUE_COMMENT', author: c.author.login, body: c.body, createdAt: c.createdAt });
const fromThread = { id: threadComment.id, threadId: thread.id, source: 'REVIEW_THREAD', author: threadComment.author, body: threadComment.body, createdAt: threadComment.createdAt, path: threadComment.path, line: threadComment.line };

const settingsComment = fromConversation(conversation(pr1.number, SAY.settings));
const shortcutComment = fromConversation(conversation(pr1.number, SAY.shortcut));
const questionComment = fromConversation(conversation(pr1.number, SAY.question));
const item = (c: any, extra: Record<string, any>) => ({ commentId: c.id, author: c.author, excerpt: c.body.slice(0, 90), reasoning: '', filesInvolved: [] as string[], ...extra });

const replies = {
  defect: 'Good catch: themeFor hands out the shared tokens object, so a caller that changes it changes the theme for everyone. The next round returns a copy and tests it.',
  settings: `You want the settings page in dark mode too. That is part of the Screens phase (phase 2 of the roadmap); it is not part of this design-system pull request.`,
  shortcut: 'You want a keyboard shortcut for the theme toggle. No phase of the roadmap covers it, so it would be new work of its own.',
  question: 'cssVariables returns the tokens as CSS custom properties, so the theme can change at runtime without rebuilding the styles; Tailwind\'s dark: variants are decided at build time. The two can be combined once the screens use the tokens (phase 2).',
};
writeTriage({
  pullRequest: pr1, branch: branch1, action: 'RERUN_IMPLEMENTATION',
  summary: 'One defect in this pull request (a developer fix), two requests that belong to later phases (one the roadmap covers, one it does not), and one question answered directly.',
  followUpTask: 'In ui/src/lib/theme.js make themeFor return a copy of the tokens instead of the shared object, and add a test that changing the result does not change the theme. Change nothing else.',
  roundTitle: 'Return a copy of the theme tokens',
  items: [
    item(fromThread, { category: 'CODE_CHANGE_REQUEST', assignTo: 'developer', reply: replies.defect }),
    item(settingsComment, { category: 'FUTURE_PHASE', assignTo: 'none', targetPhase: project.phases[1]!.id, reply: replies.settings }),
    item(shortcutComment, { category: 'FUTURE_PHASE', assignTo: 'none', targetPhase: 'NEW', phaseTitle: 'Keyboard shortcut for the theme toggle', reply: replies.shortcut }),
    item(questionComment, { category: 'QUESTION', assignTo: 'none', reply: replies.question }),
  ],
  comments: [
    { ...fromThread, category: 'CODE_CHANGE_REQUEST', reply: replies.defect },
    { ...settingsComment, category: 'FUTURE_PHASE', targetPhase: project.phases[1]!.id, reply: replies.settings },
    { ...shortcutComment, category: 'FUTURE_PHASE', targetPhase: 'NEW', phaseTitle: 'Keyboard shortcut for the theme toggle', reply: replies.shortcut },
    { ...questionComment, category: 'QUESTION', reply: replies.question },
  ],
});

const why = fromConversation(conversation(pr2.number, 'Why two decimals and not one?'));
const nice = fromConversation(conversation(pr2.number, 'Nice tests, thanks!'));
writeTriage({
  pullRequest: pr2, branch: branch2, action: 'REPLY_ONLY',
  summary: 'A question and a compliment: nothing to change.',
  items: [
    item(why, { category: 'QUESTION', assignTo: 'none', reply: 'Money is shown with two decimals, so a percentage next to it reads the same way. Say so if you would rather have one.' }),
    item(nice, { category: 'PRAISE_OR_NOTE', assignTo: 'none', reply: 'Thanks!' }),
  ],
  comments: [
    { ...why, category: 'QUESTION', reply: 'Money is shown with two decimals, so a percentage next to it reads the same way. Say so if you would rather have one.' },
    { ...nice, category: 'PRAISE_OR_NOTE', reply: 'Thanks!' },
  ],
});

console.log(`  project ${project.id} "${PROJECT_TITLE}": phase 1 is task ${t1}, pull request #${pr1.number} (4 review comments waiting)`);
console.log(`  plain task ${t2}: pull request #${pr2.number} (2 comments, only to answer)`);
console.log(`  plain task ${t3}: pull request #${pr3.number} (nothing to answer: ready to approve and merge)`);
console.log(`  checkouts: ${tree1.path}\n             ${tree2.path}\n             ${tree3.path}`);
