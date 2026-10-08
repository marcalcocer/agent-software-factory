/**
 * Repository context packing.
 *
 * Agents cannot read an entire repository, so these tools build token-optimised context
 * blocks: a directory tree, a targeted content search and a packed bundle of selected files.
 *
 * `pack-repository` uses the `repomix` CLI when it is available (richer output, respects
 * `.gitignore` and `.repomixignore`), and otherwise falls back to a built-in packer with the
 * same contract - so the factory works offline and without extra global installs.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { getFactoryConfig, resolveInsideRepo, resolveRepoPath } from '../utils/factory-config.ts';
import { runProcess } from '../utils/shell.ts';
import { writeContextBlock } from './logger-tools.ts';

function repo(repoPath: string): string {
  return resolveRepoPath(repoPath, { requireGit: false });
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'target',
  'build',
  'dist',
  'out',
  '.gradle',
  '.mvn',
  '.idea',
  '.vscode',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.pytest_cache',
  '.mypy_cache',
  '.terraform',
  'vendor',
  '.mastra',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.pdf', '.zip', '.gz', '.tar', '.tgz', '.jar', '.war', '.class',
  '.so', '.dylib', '.dll', '.exe', '.bin', '.woff', '.woff2', '.ttf',
  '.eot', '.mp3', '.mp4', '.mov', '.avi', '.sqlite', '.db', '.lock',
]);

const MAX_FILE_CHARS = 60_000;

/** Rough token estimate (~4 characters per token), enough for budgeting decisions. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface WalkOptions {
  includeExtensions?: string[];
  maxFiles?: number;
  maxDepth?: number;
}

/** Depth-first walk of a repository, skipping build output and binary files. */
function walkRepository(root: string, options: WalkOptions = {}): string[] {
  const { includeExtensions, maxFiles = 4_000, maxDepth = 12 } = options;
  const collected: string[] = [];

  const visit = (directory: string, depth: number): void => {
    if (depth > maxDepth || collected.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (collected.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.name !== '.github') {
        if (entry.isDirectory()) continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(extension)) continue;
      if (includeExtensions && includeExtensions.length > 0 && !includeExtensions.includes(extension)) {
        continue;
      }
      collected.push(path.relative(root, absolute));
    }
  };

  visit(root, 0);
  return collected;
}

/** Simple glob matcher supporting `*`, `**` and `?`. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(filePath));
}

/* -------------------------------------------------------------------------- */
/* Built-in packer                                                             */
/* -------------------------------------------------------------------------- */

export interface PackResult {
  content: string;
  files: string[];
  skippedFiles: string[];
  estimatedTokens: number;
  truncated: boolean;
  engine: 'repomix' | 'builtin';
}

export function packRepositoryBuiltin(
  repoPath: string,
  options: { include?: string[]; exclude?: string[]; maxTokens?: number } = {},
): PackResult {
  const { include = [], exclude = [], maxTokens = 40_000 } = options;
  const candidates = walkRepository(repoPath)
    .filter((file) => (include.length === 0 ? true : matchesAny(file, include)))
    .filter((file) => (exclude.length === 0 ? true : !matchesAny(file, exclude)));

  const sections: string[] = [
    '# Packed repository context',
    '',
    `Repository: ${repoPath}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Files included',
    '',
  ];

  const included: string[] = [];
  const skipped: string[] = [];
  let budget = maxTokens;
  let truncated = false;

  const bodies: string[] = [];
  for (const file of candidates) {
    if (budget <= 0) {
      truncated = true;
      skipped.push(file);
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoPath, file), 'utf8');
    } catch {
      skipped.push(file);
      continue;
    }
    if (content.includes('\u0000')) {
      skipped.push(file);
      continue;
    }
    const clipped =
      content.length > MAX_FILE_CHARS
        ? `${content.slice(0, MAX_FILE_CHARS)}\n[... file truncated ...]`
        : content;
    const cost = estimateTokens(clipped);
    if (cost > budget) {
      truncated = true;
      skipped.push(file);
      continue;
    }
    budget -= cost;
    included.push(file);
    const language = path.extname(file).replace('.', '') || 'text';
    bodies.push(`### ${file}\n\n\`\`\`${language}\n${clipped}\n\`\`\`\n`);
  }

  sections.push(...included.map((file) => `- ${file}`), '', '## File contents', '', ...bodies);
  const content = sections.join('\n');

  return {
    content,
    files: included,
    skippedFiles: skipped,
    estimatedTokens: estimateTokens(content),
    truncated,
    engine: 'builtin',
  };
}

/** Packs a repository with the `repomix` CLI, falling back to the built-in packer. */
export async function packRepository(
  repoPath: string,
  options: { include?: string[]; exclude?: string[]; maxTokens?: number; useRepomix?: boolean } = {},
): Promise<PackResult> {
  const useRepomix = options.useRepomix ?? getFactoryConfig().enableRepomix;
  if (!useRepomix) return packRepositoryBuiltin(repoPath, options);

  const outputFile = path.join(
    fs.mkdtempSync(path.join(getFactoryConfig().logDir, '.repomix-')),
    'pack.md',
  );
  const args = ['-y', 'repomix', '--style', 'markdown', '--output', outputFile, '--no-file-summary'];
  if (options.include && options.include.length > 0) args.push('--include', options.include.join(','));
  if (options.exclude && options.exclude.length > 0) args.push('--ignore', options.exclude.join(','));

  try {
    const result = await runProcess('npx', args, {
      cwd: repoPath,
      timeoutMs: 180_000,
      trusted: true,
    });
    if (!result.ok || !fs.existsSync(outputFile)) {
      return packRepositoryBuiltin(repoPath, options);
    }

    const raw = fs.readFileSync(outputFile, 'utf8');
    const maxChars = (options.maxTokens ?? 40_000) * 4;
    const truncated = raw.length > maxChars;
    const content = truncated
      ? `${raw.slice(0, maxChars)}\n\n[... packed context truncated to fit the token budget ...]`
      : raw;
    const files = [...raw.matchAll(/^##\s+File:\s+(.+)$/gm)].map((match) => match[1]!.trim());

    return {
      content,
      files,
      skippedFiles: [],
      estimatedTokens: estimateTokens(content),
      truncated,
      engine: 'repomix',
    };
  } catch {
    return packRepositoryBuiltin(repoPath, options);
  } finally {
    fs.rmSync(path.dirname(outputFile), { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* Agent-facing tools                                                          */
/* -------------------------------------------------------------------------- */

export const repositoryTreeTool = createTool({
  id: 'repository-tree',
  description:
    'List the files of the target repository (build output, dependencies and binaries excluded). ' +
    'The cheapest way to orient yourself before reading or packing anything.',
  inputSchema: z.object({
    repoPath: z.string(),
    subPath: z.string().optional().describe('Restrict the listing to this repository-relative folder.'),
    extensions: z
      .array(z.string())
      .optional()
      .describe('Keep only these extensions, e.g. [".java", ".xml"].'),
    maxFiles: z.number().int().min(1).max(5_000).default(800),
  }),
  outputSchema: z.object({
    root: z.string(),
    fileCount: z.number().int(),
    files: z.array(z.string()),
    truncated: z.boolean(),
  }),
  execute: async ({ repoPath, subPath, extensions, maxFiles }) => {
    const root = repo(repoPath);
    const target = subPath ? resolveInsideRepo(root, subPath) : root;
    const walkOptions: WalkOptions = { maxFiles: maxFiles + 1 };
    if (extensions !== undefined) walkOptions.includeExtensions = extensions;
    const files = walkRepository(target, walkOptions);
    const truncated = files.length > maxFiles;
    return {
      root: path.relative(root, target) || '.',
      fileCount: Math.min(files.length, maxFiles),
      files: files.slice(0, maxFiles),
      truncated,
    };
  },
});

export const searchRepositoryTool = createTool({
  id: 'search-repository',
  description:
    'Search the target repository for a regular expression and return the matching lines with ' +
    'their file and line number. Use it to locate symbols, usages and configuration keys ' +
    'before reading whole files.',
  inputSchema: z.object({
    repoPath: z.string(),
    pattern: z.string().describe('JavaScript regular expression.'),
    extensions: z.array(z.string()).optional(),
    maxMatches: z.number().int().min(1).max(500).default(80),
    caseSensitive: z.boolean().default(false),
  }),
  outputSchema: z.object({
    matches: z.array(
      z.object({ file: z.string(), line: z.number().int(), text: z.string() }),
    ),
    filesScanned: z.number().int(),
    truncated: z.boolean(),
  }),
  execute: async ({ repoPath, pattern, extensions, maxMatches, caseSensitive }) => {
    const root = repo(repoPath);
    let regexp: RegExp;
    try {
      regexp = new RegExp(pattern, caseSensitive ? '' : 'i');
    } catch (error) {
      throw new Error(`Invalid regular expression "${pattern}": ${String(error)}`);
    }

    const walkOptions: WalkOptions = {};
    if (extensions !== undefined) walkOptions.includeExtensions = extensions;
    const files = walkRepository(root, walkOptions);
    const matches: { file: string; line: number; text: string }[] = [];
    let filesScanned = 0;

    for (const file of files) {
      if (matches.length >= maxMatches) break;
      let content: string;
      try {
        content = fs.readFileSync(path.join(root, file), 'utf8');
      } catch {
        continue;
      }
      filesScanned += 1;
      for (const [index, line] of content.split('\n').entries()) {
        if (matches.length >= maxMatches) break;
        if (!regexp.test(line)) continue;
        matches.push({ file, line: index + 1, text: line.trim().slice(0, 400) });
      }
    }

    return { matches, filesScanned, truncated: matches.length >= maxMatches };
  },
});

export const packRepositoryTool = createTool({
  id: 'pack-repository',
  description:
    'Pack selected repository files into a single token-optimised context block (uses the ' +
    '`repomix` CLI when available). Always narrow the scope with `include` patterns and a ' +
    '`maxTokens` budget; the full block is also saved to the run trace for auditing.',
  inputSchema: z.object({
    repoPath: z.string(),
    include: z
      .array(z.string())
      .optional()
      .describe('Glob patterns to include, e.g. ["src/main/java/**/*.java", "pom.xml"].'),
    exclude: z.array(z.string()).optional().describe('Glob patterns to exclude.'),
    maxTokens: z.number().int().min(1_000).max(200_000).default(30_000),
    runId: z.string().optional().describe('Run id: saves the packed block under logs/<runId>/context/.'),
    label: z.string().optional().describe('File name for the saved context block.'),
  }),
  outputSchema: z.object({
    engine: z.string(),
    estimatedTokens: z.number().int(),
    fileCount: z.number().int(),
    files: z.array(z.string()),
    truncated: z.boolean(),
    savedTo: z.string().nullable(),
    content: z.string(),
  }),
  execute: async ({ repoPath, include, exclude, maxTokens, runId, label }) => {
    const root = repo(repoPath);
    const packOptions: Parameters<typeof packRepository>[1] = { maxTokens };
    if (include !== undefined) packOptions.include = include;
    if (exclude !== undefined) packOptions.exclude = exclude;

    const packed = await packRepository(root, packOptions);
    const savedTo = runId
      ? writeContextBlock(runId, label ?? `pack-${Date.now()}.md`, packed.content)
      : null;

    return {
      engine: packed.engine,
      estimatedTokens: packed.estimatedTokens,
      fileCount: packed.files.length,
      files: packed.files.slice(0, 200),
      truncated: packed.truncated,
      savedTo,
      content: packed.content,
    };
  },
});

export const repomixTools = {
  repositoryTreeTool,
  searchRepositoryTool,
  packRepositoryTool,
};
