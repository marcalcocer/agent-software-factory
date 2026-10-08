/**
 * Filesystem tools for the implementation agents.
 *
 * Every path is resolved through `resolveInsideRepo`, which rejects traversal outside the
 * target repository and blocks direct access to `.git`. Read tools are granted to every
 * agent; write tools only to the Developer agent (code) and the Documentation agent (docs).
 */
import fs from 'node:fs';
import path from 'node:path';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { resolveInsideRepo, resolveRepoPath } from '../utils/factory-config.ts';

function repo(repoPath: string): string {
  return resolveRepoPath(repoPath, { requireGit: false });
}

const MAX_READ_CHARS = 120_000;
const MAX_WRITE_CHARS = 400_000;

/** Documentation-only extensions: the Documentation agent must not touch source code. */
const DOCUMENTATION_PATTERN =
  /(\.(md|mdx|rst|adoc|txt)$)|(^docs\/)|(\/docs\/)|(openapi.*\.(ya?ml|json)$)|(asyncapi.*\.(ya?ml|json)$)|(swagger.*\.(ya?ml|json)$)/i;

export const readFileTool = createTool({
  id: 'read-file',
  description:
    'Read a UTF-8 text file from the target repository. Use `startLine`/`endLine` to read a ' +
    'window of a large file.',
  inputSchema: z.object({
    repoPath: z.string(),
    filePath: z.string().describe('Repository-relative path.'),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  }),
  outputSchema: z.object({
    filePath: z.string(),
    content: z.string(),
    totalLines: z.number().int(),
    truncated: z.boolean(),
  }),
  execute: async ({ repoPath, filePath, startLine, endLine }) => {
    const absolute = resolveInsideRepo(repo(repoPath), filePath);
    if (!fs.existsSync(absolute)) throw new Error(`File not found: ${filePath}`);
    if (!fs.statSync(absolute).isFile()) throw new Error(`Not a file: ${filePath}`);

    const raw = fs.readFileSync(absolute, 'utf8');
    const lines = raw.split('\n');

    if (startLine === undefined && endLine === undefined) {
      const truncated = raw.length > MAX_READ_CHARS;
      return {
        filePath,
        content: truncated ? `${raw.slice(0, MAX_READ_CHARS)}\n[... truncated ...]` : raw,
        totalLines: lines.length,
        truncated,
      };
    }

    const from = (startLine ?? 1) - 1;
    const to = endLine ?? lines.length;
    return {
      filePath,
      content: lines.slice(from, to).join('\n'),
      totalLines: lines.length,
      truncated: to < lines.length || from > 0,
    };
  },
});

export const listDirectoryTool = createTool({
  id: 'list-directory',
  description: 'List the entries of a directory inside the target repository.',
  inputSchema: z.object({
    repoPath: z.string(),
    directoryPath: z.string().default('.').describe('Repository-relative directory.'),
  }),
  outputSchema: z.object({
    directoryPath: z.string(),
    entries: z.array(
      z.object({ name: z.string(), type: z.enum(['file', 'directory']), sizeBytes: z.number().int() }),
    ),
  }),
  execute: async ({ repoPath, directoryPath }) => {
    const absolute = resolveInsideRepo(repo(repoPath), directoryPath);
    if (!fs.existsSync(absolute)) throw new Error(`Directory not found: ${directoryPath}`);

    const entries = fs.readdirSync(absolute, { withFileTypes: true }).map((entry) => {
      const entryPath = path.join(absolute, entry.name);
      let sizeBytes = 0;
      try {
        sizeBytes = entry.isFile() ? fs.statSync(entryPath).size : 0;
      } catch {
        sizeBytes = 0;
      }
      return {
        name: entry.name,
        type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
        sizeBytes,
      };
    });

    return { directoryPath, entries };
  },
});

export const writeFileTool = createTool({
  id: 'write-file',
  description:
    'Create a file or replace its entire content inside the target repository. Parent ' +
    'directories are created automatically. Prefer `edit-file` for surgical changes to an ' +
    'existing file.',
  inputSchema: z.object({
    repoPath: z.string(),
    filePath: z.string().describe('Repository-relative path.'),
    content: z.string(),
  }),
  outputSchema: z.object({
    filePath: z.string(),
    created: z.boolean(),
    bytesWritten: z.number().int(),
  }),
  execute: async ({ repoPath, filePath, content }) => {
    if (content.length > MAX_WRITE_CHARS) {
      throw new Error(
        `Refusing to write ${content.length} characters to ${filePath}: split the change.`,
      );
    }
    const absolute = resolveInsideRepo(repo(repoPath), filePath);
    const existed = fs.existsSync(absolute);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
    return { filePath, created: !existed, bytesWritten: Buffer.byteLength(content, 'utf8') };
  },
});

export const editFileTool = createTool({
  id: 'edit-file',
  description:
    'Replace an exact snippet inside an existing file. `oldString` must appear exactly once ' +
    '(include surrounding context to make it unique), otherwise the edit is rejected. This is ' +
    'the safest way to modify existing code.',
  inputSchema: z.object({
    repoPath: z.string(),
    filePath: z.string(),
    oldString: z.string().describe('Exact text to replace, including indentation.'),
    newString: z.string().describe('Replacement text.'),
    replaceAll: z.boolean().default(false).describe('Replace every occurrence instead of failing.'),
  }),
  outputSchema: z.object({
    filePath: z.string(),
    replacements: z.number().int(),
  }),
  execute: async ({ repoPath, filePath, oldString, newString, replaceAll }) => {
    const absolute = resolveInsideRepo(repo(repoPath), filePath);
    if (!fs.existsSync(absolute)) throw new Error(`File not found: ${filePath}`);
    if (oldString === newString) throw new Error('`oldString` and `newString` are identical.');

    const original = fs.readFileSync(absolute, 'utf8');
    const occurrences = original.split(oldString).length - 1;

    if (occurrences === 0) {
      throw new Error(
        `Snippet not found in ${filePath}. Read the file again: its content differs from what ` +
          'you assumed.',
      );
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `Snippet found ${occurrences} times in ${filePath}. Add surrounding context to make it ` +
          'unique, or set `replaceAll: true`.',
      );
    }

    const updated = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString);
    fs.writeFileSync(absolute, updated, 'utf8');
    return { filePath, replacements: replaceAll ? occurrences : 1 };
  },
});

/** Documentation-scoped variants: same behaviour, restricted to documentation files. */
function assertDocumentationPath(filePath: string): void {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!DOCUMENTATION_PATTERN.test(normalized)) {
    throw new Error(
      `"${filePath}" is not a documentation file. The Documentation agent may only write ` +
        'Markdown/reStructuredText/AsciiDoc files, files under docs/, and OpenAPI/AsyncAPI specs.',
    );
  }
}

export const writeDocumentationFileTool = createTool({
  id: 'write-file',
  description:
    'Create or replace a DOCUMENTATION file (Markdown, docs/**, OpenAPI/AsyncAPI spec) inside ' +
    'the target repository. Source code, tests and build files are rejected.',
  inputSchema: writeFileTool.inputSchema,
  outputSchema: writeFileTool.outputSchema,
  execute: async (input, context) => {
    assertDocumentationPath(input.filePath);
    return await writeFileTool.execute!(input, context);
  },
});

export const editDocumentationFileTool = createTool({
  id: 'edit-file',
  description:
    'Replace an exact snippet inside an existing DOCUMENTATION file (Markdown, docs/**, ' +
    'OpenAPI/AsyncAPI spec). Source code, tests and build files are rejected.',
  inputSchema: editFileTool.inputSchema,
  outputSchema: editFileTool.outputSchema,
  execute: async (input, context) => {
    assertDocumentationPath(input.filePath);
    return await editFileTool.execute!(input, context);
  },
});

/** Read-only filesystem tools, safe for every agent. */
export const filesystemReadTools = {
  readFileTool,
  listDirectoryTool,
};

/** Write tools for the Developer agent. */
export const filesystemWriteTools = {
  writeFileTool,
  editFileTool,
};

/** Write tools for the Documentation agent (documentation files only). */
export const documentationWriteTools = {
  writeFileTool: writeDocumentationFileTool,
  editFileTool: editDocumentationFileTool,
};
