// Where a relative BLOB_DIR lands (`blobRoot`): the checkout itself, or, in a linked git worktree,
// the main checkout, because every worktree of a clone shares the one development database.
// Built from the files git writes, so no git process and no real repository is needed.
// Rejected: running `git worktree add` here (slower, and a test that needs git on PATH).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobRoot } from './compose.js';

describe('blobRoot', () => {
  let base = '';
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'mycel-blob-root-'));
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('keeps a plain checkout, whose .git is a directory', async () => {
    const main = join(base, 'plain');
    await mkdir(join(main, '.git'), { recursive: true });
    expect(blobRoot(main)).toBe(main);
  });

  it('keeps a directory without .git, as in a production image', async () => {
    const dir = join(base, 'image');
    await mkdir(dir, { recursive: true });
    expect(blobRoot(dir)).toBe(dir);
  });

  it('takes a linked worktree to the main checkout it belongs to', async () => {
    const main = join(base, 'clone');
    const meta = join(main, '.git', 'worktrees', 'agent-1');
    const worktree = join(main, '.claude', 'worktrees', 'agent-1');
    await mkdir(meta, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(meta, 'commondir'), '../..\n');
    await writeFile(join(worktree, '.git'), `gitdir: ${meta}\n`);
    expect(blobRoot(worktree)).toBe(main);
  });

  it('keeps a submodule, whose git directory has no commondir', async () => {
    const sub = join(base, 'super', 'sub');
    const modules = join(base, 'super', '.git', 'modules', 'sub');
    await mkdir(modules, { recursive: true });
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
    expect(blobRoot(sub)).toBe(sub);
  });
});
