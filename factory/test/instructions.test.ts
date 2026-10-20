import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeInstructions } from '../src/utils/context-loader.ts';

let repo: string;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-instructions-'));
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Rules\n\nAlways use var for locals.\n');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('composeInstructions', () => {
  it('gives the coding roles the conventions: the factory\'s rules and the repository\'s AGENTS.md', () => {
    for (const role of ['developer', 'reviewer', 'pr-writer'] as const) {
      const text = composeInstructions(role, repo);
      expect(text).toContain('Always use var for locals.');
      expect(text).toContain('Active target repository');
    }
  });

  it('gives the run namer its prompt and nothing else, so its calls stay as small as they can be', () => {
    const text = composeInstructions('run-namer', repo);

    expect(text).toContain('# Role: Run namer');
    expect(text).not.toContain('Always use var for locals.');
    expect(text).not.toContain('Active target repository');
    expect(text.length).toBeLessThan(4_000);
    expect(text.length).toBeLessThan(composeInstructions('developer', repo).length / 2);
  });
});
