// The teaser follows the paywall through the block operations (ADR 018 rule 6): the first paywall
// sets the marker, removing the last one falls back to `lead`, every other operation keeps the
// teaser, and on an older base an operation that would change the teaser is a `conflict` when
// someone set another teaser since (ADRs 026, 027). Kept apart from `operations.test.ts`, which
// covers the operations themselves; the database conformance repeats the write path in Postgres.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal, type Principal } from '../principal.js';
import { MemoryUnitOfWork, TENANT } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import type { Block } from './blocks.js';

const para = (t: string) => ({ type: 'paragraph' as const, content: [{ type: 'text', text: t }] });
const doc = (...content: object[]) => ({ type: 'doc' as const, content });
const headingBlock = (id: string) => ({
  id,
  type: 'heading' as const,
  version: 1 as const,
  props: { text: { nl: 'Kop', en: 'Heading' } },
});
const paywall = { type: 'paywall' as const, version: 1 as const, props: {} };

describe('a paywall brings its teaser along', () => {
  let invoker: Invoker;
  let admin: Principal;

  beforeEach(() => {
    invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    admin = systemPrincipal(TENANT, 'test');
  });

  const create = (blocks: object[], access?: object) =>
    invoker.run(useCases.createItem, admin, {
      slug: `item-${Math.random().toString(36).slice(2)}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Titel', en: 'Title' },
        ...(access && { access }),
        blocks,
      } as never,
    });
  const restricted = (blocks: object[], teaser: object | string) =>
    create(blocks, { level: 'members', teaser });
  const ids = (blocks: readonly Block[]) => blocks.map((b) => b.id);
  const revisionCount = async (itemId: string) =>
    (await invoker.run(useCases.listRevisions, admin, { itemId })).revisions.length;

  it.each([['lead'], [{ blocks: 1 }]])(
    'inserting the first paywall on teaser %o sets the marker, removing it sets lead',
    async (teaser) => {
      const { item, revision } = await restricted(
        [headingBlock('open'), headingBlock('paid')],
        teaser
      );
      const inserted = await invoker.run(useCases.insertBlock, admin, {
        itemId: item.id,
        baseRevisionId: revision.id,
        block: { ...paywall, id: 'wall' },
        place: { after: 'open' },
      });
      expect(inserted.revision.document.access).toEqual({ level: 'members', teaser: 'marker' });
      expect(ids(inserted.revision.document.blocks)).toEqual(['open', 'wall', 'paid']);
      const removed = await invoker.run(useCases.removeBlock, admin, {
        itemId: item.id,
        baseRevisionId: inserted.revision.id,
        blockId: 'wall',
      });
      expect(removed.revision.document.access).toEqual({ level: 'members', teaser: 'lead' });
      expect(ids(removed.revision.document.blocks)).toEqual(['open', 'paid']);
    }
  );

  it('a split that puts in the first paywall sets the marker as well', async () => {
    const text = {
      id: 't',
      type: 'rich-text' as const,
      version: 1 as const,
      props: { content: { nl: doc(para('1'), para('2')), en: doc(para('one'), para('two')) } },
    };
    const { item, revision } = await restricted([text], 'lead');
    const out = await invoker.run(useCases.splitInsertBlock, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      blockId: 't',
      at: { nl: 1, en: 1 },
      block: paywall,
    });
    expect(out.revision.document.access.teaser).toBe('marker');
  });

  it('an open item gets the marker too, so the boundary waits for a restricted level', async () => {
    const { item, revision } = await create([headingBlock('open')]);
    const out = await invoker.run(useCases.insertBlock, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      block: paywall,
      place: { at: 'end' },
    });
    expect(out.revision.document.access).toEqual({ level: 'public', teaser: 'marker' });
  });

  it('other operations keep the teaser, and a second paywall is still refused', async () => {
    const { item, revision } = await restricted(
      [headingBlock('open'), { ...paywall, id: 'wall' }, headingBlock('paid')],
      'marker'
    );
    const moved = await invoker.run(useCases.moveBlock, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      blockId: 'wall',
      place: { at: 'start' },
    });
    expect(moved.revision.document.access.teaser).toBe('marker');
    const other = await invoker.run(useCases.removeBlock, admin, {
      itemId: item.id,
      baseRevisionId: moved.revision.id,
      blockId: 'paid',
    });
    expect(other.revision.document.access.teaser).toBe('marker');
    await expect(
      invoker.run(useCases.insertBlock, admin, {
        itemId: item.id,
        baseRevisionId: other.revision.id,
        block: paywall,
        place: { at: 'end' },
      })
    ).rejects.toMatchObject({
      code: 'invalid_input',
      issues: expect.arrayContaining([
        expect.objectContaining({ message: 'content.access.marker-needs-one-paywall' }),
      ]),
    });
    expect(await revisionCount(item.id)).toBe(3);
  });

  describe('on an older base', () => {
    /** An item on `lead`, then a newer revision by someone else with `access` and `blocks`. */
    const withNewer = async (access: object, blocks?: object[]) => {
      const { item, revision } = await restricted([headingBlock('open')], 'lead');
      const newer = await invoker.run(useCases.updateItem, admin, {
        itemId: item.id,
        baseRevisionId: revision.id,
        document: {
          ...revision.document,
          access,
          ...(blocks && { blocks }),
        } as never,
      });
      return { itemId: item.id, base: revision.id, newer: newer.revision.id };
    };

    it('an insert that would overwrite a teaser someone set since is a conflict', async () => {
      const { itemId, base, newer } = await withNewer({ level: 'members', teaser: { blocks: 1 } });
      await expect(
        invoker.run(useCases.insertBlock, admin, {
          itemId,
          baseRevisionId: base,
          block: paywall,
          place: { at: 'end' },
        })
      ).rejects.toMatchObject({
        code: 'conflict',
        issues: expect.arrayContaining([
          expect.objectContaining({ path: 'baseRevisionId', params: { latestRevisionId: newer } }),
          expect.objectContaining({ path: 'document.access.teaser' }),
        ]),
      });
      expect(await revisionCount(itemId)).toBe(2);
      const latest = await invoker.run(useCases.getItem, admin, { itemId });
      expect(latest.revision.document.access.teaser).toEqual({ blocks: 1 });
    });

    it('an insert rebases when only the level moved, and the teaser still follows', async () => {
      const { itemId, base, newer } = await withNewer({ level: 'public', teaser: 'lead' });
      const out = await invoker.run(useCases.insertBlock, admin, {
        itemId,
        baseRevisionId: base,
        block: paywall,
        place: { at: 'end' },
      });
      expect(out.revision.provenance).toMatchObject({ merged: { latestRevisionId: newer } });
      expect(out.revision.document.access).toEqual({ level: 'public', teaser: 'marker' });
    });

    it('an operation that leaves the teaser alone rebases over a moved teaser', async () => {
      const { itemId, base, newer } = await withNewer({ level: 'members', teaser: { blocks: 1 } }, [
        headingBlock('open'),
        headingBlock('more'),
      ]);
      const out = await invoker.run(useCases.insertBlock, admin, {
        itemId,
        baseRevisionId: base,
        block: headingBlock('new'),
        place: { at: 'start' },
      });
      expect(out.revision.provenance).toMatchObject({ merged: { latestRevisionId: newer } });
      expect(out.revision.document.access.teaser).toEqual({ blocks: 1 });
      expect(ids(out.revision.document.blocks)).toEqual(['new', 'open', 'more']);
    });
  });
});
