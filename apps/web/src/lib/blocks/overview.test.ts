// What the renderer makes of an overview: the list is part of the render model, so the
// public page's ETag digest (public-page.ts hashes the model) moves when an article joins the
// list or one is republished, without a new revision of the host page. Only a block with an
// archive follows `?p=`, and its page links point at the host's own path. Which items a list
// holds is proven over both adapters in packages/db/src/adapter-rules.test.ts.
import { describe, expect, it } from 'vitest';
import { Block, BLOCK_DEFINITIONS, projectBlock, type Overview } from '@mycel/core';
import { resolveDocument, type ResolveSource } from './resolve.js';

const block = (id: string, props: Record<string, unknown>) =>
  Block.parse({ id, type: 'overview', version: BLOCK_DEFINITIONS.overview.version, props });

const entry = (n: number, revision = 0) => ({
  id: `01900000-0000-7000-8000-00000000e0${n}${revision}`,
  type: 'article' as const,
  slug: `bericht-${n}`,
  revisionId: `01900000-0000-7000-8000-00000000e1${n}${revision}`,
  date: `2026-11-0${n}T10:00:00.000Z`,
  title: `Bericht ${n}`,
  summary: null,
  imageId: null,
  pinned: false,
});

async function model(list: (page: number) => Overview, blocks: Block[], page = 1) {
  const pages: number[] = [];
  const source: ResolveSource = {
    form: async () => null,
    media: async () => null,
    itemPath: async () => null,
    overview: async (_props, _locale, p) => (pages.push(p), list(p)),
  };
  const resolved = await resolveDocument(
    source,
    { locale: 'nl', title: 'Nieuws', blocks: blocks.map((b) => projectBlock(b, 'nl')) },
    { base: '', fallbackLocale: 'nl', path: '/nieuws', page, timeZone: 'Europe/Amsterdam' }
  );
  return { resolved, pages };
}

describe('an overview in the render model', () => {
  const archive = block('a', { archive: true, limit: '2' });

  it('changes when an article joins the list or is republished', async () => {
    const before = await model(() => ({ entries: [entry(1)], older: false }), [archive]);
    const joined = await model(() => ({ entries: [entry(2), entry(1)], older: false }), [archive]);
    const republished = await model(() => ({ entries: [entry(1, 1)], older: false }), [archive]);
    expect(JSON.stringify(joined.resolved)).not.toBe(JSON.stringify(before.resolved));
    expect(JSON.stringify(republished.resolved)).not.toBe(JSON.stringify(before.resolved));
  });

  it('links older and newer pages on the host path, only with an archive', async () => {
    const plain = block('b', { limit: '2' });
    const { resolved, pages } = await model(
      () => ({ entries: [entry(1)], older: true }),
      [archive, plain],
      2
    );
    expect(pages).toEqual([2, 1]);
    const [paged, fixed] = resolved.blocks;
    expect(paged).toMatchObject({ type: 'overview', older: '/nieuws?p=3', newer: '/nieuws' });
    expect(fixed).toMatchObject({ type: 'overview', older: null, newer: null });
  });

  it('dates an entry in the site time zone', async () => {
    const late = { ...entry(1), date: '2026-11-01T23:30:00.000Z' };
    const { resolved } = await model(() => ({ entries: [late], older: false }), [archive]);
    expect(resolved.blocks[0]).toMatchObject({
      entries: [{ date: { iso: '2026-11-02', label: '2 november 2026' } }],
    });
  });
});
