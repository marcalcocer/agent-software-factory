import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { changesSince, restoreWorkingTree, snapshotWorkingTree } from '../src/tools/git-tools.ts';
import { createBigChangeRepo } from './support/git-repo';

/** The state of the work when the polish pass starts: a lot changed, some of it new, none of it committed. */
let repo: string;
let git: (...args: string[]) => string;
let cleanup: () => void;

beforeEach(() => {
  ({ repo, git, cleanup } = createBigChangeRepo());
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep.js'), 'module.exports = 1;\n');
});
afterEach(() => cleanup());

const file = (name: string) => path.join(repo, name);
const read = (name: string) => fs.readFileSync(file(name), 'utf8');
const status = () => git('status', '--porcelain').split('\n').filter(Boolean).sort();

describe('snapshotWorkingTree / restoreWorkingTree', () => {
  it('undoes edits, deletions and new files, and leaves ignored files alone', async () => {
    const before = { statusLines: status(), file00: read('src/file00.ts'), fresh: read('src/brand-new.ts') };
    const tree = await snapshotWorkingTree(repo);

    // What a polish pass might do.
    fs.writeFileSync(file('src/file00.ts'), 'export const changed = true;\n'); // edit
    fs.rmSync(file('src/file01.ts')); // delete
    fs.writeFileSync(file('src/created-by-polish.ts'), 'export const x = 1;\n'); // create
    fs.writeFileSync(file('src/brand-new.ts'), 'export const fresh = false;\n'); // edit a new file
    fs.writeFileSync(file('node_modules/dep.js'), 'module.exports = 2;\n'); // ignored

    await restoreWorkingTree(repo, tree);

    expect(read('src/file00.ts')).toBe(before.file00);
    expect(fs.existsSync(file('src/file01.ts'))).toBe(true);
    expect(fs.existsSync(file('src/created-by-polish.ts'))).toBe(false);
    expect(read('src/brand-new.ts')).toBe(before.fresh);
    expect(read('node_modules/dep.js')).toBe('module.exports = 2;\n'); // not ours to touch
    expect(status()).toEqual(before.statusLines);
  });

  it('changes nothing by itself: no commit, nothing left staged', async () => {
    const head = git('rev-parse', 'HEAD');
    const before = status();

    await snapshotWorkingTree(repo);

    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('diff', '--cached', '--name-only').trim()).toBe('');
    expect(status()).toEqual(before);
  });

  it('can be restored more than once, from the same snapshot', async () => {
    const tree = await snapshotWorkingTree(repo);
    for (let round = 0; round < 2; round += 1) {
      fs.writeFileSync(file('src/file05.ts'), `// attempt ${round}\n`);
      await restoreWorkingTree(repo, tree);
      expect(read('src/file05.ts')).toContain("after-");
    }
  });
});

describe('changesSince', () => {
  it('reports nothing when nothing changed', async () => {
    const tree = await snapshotWorkingTree(repo);
    expect(await changesSince(repo, tree)).toEqual({ files: [], additions: 0, deletions: 0, patch: '' });
  });

  it('counts the files and lines changed since the snapshot, new files included', async () => {
    const tree = await snapshotWorkingTree(repo);
    fs.appendFileSync(file('src/file03.ts'), 'export const added1 = 1;\nexport const added2 = 2;\n');
    fs.writeFileSync(file('src/new-helper.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
    fs.rmSync(file('src/brand-new.ts'));

    const changes = await changesSince(repo, tree);

    expect(changes.files.sort()).toEqual(['src/brand-new.ts', 'src/file03.ts', 'src/new-helper.ts']);
    expect(changes.additions).toBe(5);
    expect(changes.deletions).toBe(1);
    expect(changes.patch).toContain('+export const added1 = 1;');
    expect(changes.patch).toContain('deleted file mode');
    expect(status().some((line) => line.startsWith('A ') || line.startsWith('D '))).toBe(false); // nothing left staged
  });

  it('counts a binary file as a changed file without lines', async () => {
    const tree = await snapshotWorkingTree(repo);
    fs.writeFileSync(file('logo.png'), Buffer.from([0, 1, 2, 3, 255, 0, 0, 7]));

    const changes = await changesSince(repo, tree);
    expect(changes.files).toEqual(['logo.png']);
    expect(changes.additions).toBe(0);
  });
});
