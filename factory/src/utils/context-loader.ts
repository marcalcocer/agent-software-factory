/**
 * Prompt and convention loading (the "cascading conventions" mechanism).
 *
 * Precedence, from lowest to highest:
 *   1. the agent system prompt (`src/prompts/<role>.md`),
 *   2. the factory-wide rules (`global-rules/*.md`),
 *   3. the target repository rules (`<repo>/AGENTS.md`) - these always win.
 *
 * Agents receive the composed instructions dynamically, so the same agent instance adapts to
 * whichever repository the current run targets.
 */
import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from './factory-config.ts';
import type { AgentRole } from './model-router.ts';

/** Request-context keys used to pass per-run information into dynamic agent instructions. */
export const REQUEST_CONTEXT_KEYS = {
  repoPath: 'factory.repoPath',
  repoName: 'factory.repoName',
  runId: 'factory.runId',
  attempt: 'factory.attempt',
  role: 'factory.role',
} as const;

const PROMPTS_DIR = path.join(PROJECT_ROOT, 'src', 'prompts');
const GLOBAL_RULES_DIR = path.join(PROJECT_ROOT, 'global-rules');

/** Candidate file names for repository-specific conventions, in precedence order. */
const PROJECT_RULE_FILES = ['AGENTS.md', 'docs/AGENTS.md', '.github/AGENTS.md'];

const MAX_CHARS_PER_RULE_FILE = 24_000;
const MAX_CHARS_PROJECT_RULES = 32_000;

interface CachedFile {
  mtimeMs: number;
  content: string;
}

const fileCache = new Map<string, CachedFile>();

/** Reads a UTF-8 file with an mtime-based cache (safe for `mastra dev` hot reloads). */
function readCached(filePath: string): string | null {
  try {
    const { mtimeMs } = fs.statSync(filePath);
    const cached = fileCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.content;
    const content = fs.readFileSync(filePath, 'utf8');
    fileCache.set(filePath, { mtimeMs, content });
    return content;
  } catch {
    return null;
  }
}

function clamp(content: string, maxChars: number, label: string): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n\n[... ${label} truncated at ${maxChars} characters ...]`;
}

/* -------------------------------------------------------------------------- */
/* System prompts                                                              */
/* -------------------------------------------------------------------------- */

/** Loads the system prompt of an agent role from `src/prompts/<role>.md`. */
export function loadPrompt(role: AgentRole): string {
  const filePath = path.join(PROMPTS_DIR, `${role}.md`);
  const content = readCached(filePath);
  if (content === null) {
    throw new Error(`Missing system prompt for role "${role}": expected ${filePath}`);
  }
  return content.trim();
}

/* -------------------------------------------------------------------------- */
/* Global rules                                                                */
/* -------------------------------------------------------------------------- */

export interface RuleDocument {
  /** Path relative to the project root, used for citation in reports. */
  source: string;
  content: string;
}

/** Loads every `global-rules/*.md` document, sorted by file name. */
export function loadGlobalRules(): RuleDocument[] {
  if (!fs.existsSync(GLOBAL_RULES_DIR)) return [];
  return fs
    .readdirSync(GLOBAL_RULES_DIR)
    .filter((entry) => entry.toLowerCase().endsWith('.md'))
    .sort()
    .map((entry) => {
      const absolute = path.join(GLOBAL_RULES_DIR, entry);
      return {
        source: path.posix.join('global-rules', entry),
        content: clamp(readCached(absolute) ?? '', MAX_CHARS_PER_RULE_FILE, entry),
      };
    })
    .filter((document) => document.content.trim() !== '');
}

/* -------------------------------------------------------------------------- */
/* Project rules (target repository)                                           */
/* -------------------------------------------------------------------------- */

/** Loads the target repository conventions (`AGENTS.md`), if present. */
export function loadProjectRules(repoPath: string): RuleDocument | null {
  for (const candidate of PROJECT_RULE_FILES) {
    const absolute = path.join(repoPath, candidate);
    const content = readCached(absolute);
    if (content !== null && content.trim() !== '') {
      return {
        source: candidate,
        content: clamp(content, MAX_CHARS_PROJECT_RULES, candidate),
      };
    }
  }
  return null;
}

/** Convention sources recorded in the run context and in `summary.json`. */
export function getConventionSources(repoPath: string): {
  globalRuleFiles: string[];
  projectRulesFile: string | null;
} {
  return {
    globalRuleFiles: loadGlobalRules().map((document) => document.source),
    projectRulesFile: loadProjectRules(repoPath)?.source ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Composition                                                                 */
/* -------------------------------------------------------------------------- */

/** Builds the `CONVENTIONS` block appended to every agent's system prompt. */
export function buildConventionsBlock(repoPath: string | null): string {
  const globalRules = loadGlobalRules();
  const projectRules = repoPath ? loadProjectRules(repoPath) : null;

  const sections: string[] = [
    '# CONVENTIONS (cascading)',
    '',
    'Precedence: project rules override global rules; global rules override your own habits.',
    'When a rule applies to the current change, follow it literally and cite it in your report.',
  ];

  if (globalRules.length === 0) {
    sections.push('', '## Global rules', '', '_No global rule files found._');
  } else {
    for (const document of globalRules) {
      sections.push('', `## Global rule file: \`${document.source}\``, '', document.content);
    }
  }

  if (projectRules) {
    sections.push(
      '',
      `## Project rules (HIGHEST PRECEDENCE): \`${projectRules.source}\``,
      '',
      projectRules.content,
    );
  } else {
    sections.push(
      '',
      '## Project rules',
      '',
      '_The target repository has no `AGENTS.md`. Follow the global rules and, above all, the' +
        ' idioms already present in the surrounding code._',
    );
  }

  return sections.join('\n');
}

/**
 * Composes the full instruction set for an agent role: system prompt + convention cascade.
 * Used as a dynamic `instructions` resolver so it reflects the repository of the active run.
 */
export function composeInstructions(role: AgentRole, repoPath: string | null): string {
  const header =
    repoPath === null
      ? ''
      : `\n\n---\n\n**Active target repository:** \`${repoPath}\`\n` +
        'Every path you read or write must be inside it.\n';
  return `${loadPrompt(role)}${header}\n\n---\n\n${buildConventionsBlock(repoPath)}`;
}

/** Reads the repository path from a Mastra request context, if the run provided one. */
export function repoPathFromRequestContext(requestContext?: {
  get: (key: string) => unknown;
}): string | null {
  if (!requestContext) return null;
  const value = requestContext.get(REQUEST_CONTEXT_KEYS.repoPath);
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
