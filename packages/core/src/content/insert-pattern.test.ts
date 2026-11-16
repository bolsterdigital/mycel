// `content.block.insert_pattern` in memory (ADR 013 rule 4, refined 2026-11-16): a copy of a
// pattern's blocks lands at a place with new ids and its names, in pattern order at every kind of
// place, in one revision; prose at an edge merges like a move; a stale base whose place did not
// change rebases (ADR 027), one whose place did is a conflict. Its own file because
// `operations.test.ts` is near the size ceiling; the helpers are the same shapes.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal, type Principal } from '../principal.js';
import { MemoryUnitOfWork, TENANT } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import type { Block } from './blocks.js';

const para = (text: string) => ({ type: 'paragraph' as const, content: [{ type: 'text', text }] });
const prose = (id: string | undefined, nl: string, en: string) => ({
  ...(id ? { id } : {}),
  type: 'rich-text' as const,
  version: 1 as const,
  props: {
    content: { nl: { type: 'doc', content: [para(nl)] }, en: { type: 'doc', content: [para(en)] } },
  },
});
const heading = (id: string | undefined, nl: string) => ({
  ...(id ? { id } : {}),
  type: 'heading' as const,
  version: 1 as const,
  props: { text: { nl, en: nl } },
});

describe('content.block.insert_pattern', () => {
  let invoker: Invoker;
  let admin: Principal;

  beforeEach(() => {
    invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    admin = systemPrincipal(TENANT, 'test');
  });

  const create = (blocks: object[]) =>
    invoker.run(useCases.createItem, admin, {
      slug: 'page',
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Titel', en: 'Title' },
        blocks,
      } as never,
    });
  /** A pattern of a named heading and a named closing heading around nothing else. */
  const pattern = (blocks: object[]) =>
    invoker.run(useCases.createPattern, admin, {
      name: { nl: 'Oproep' },
      intendedType: 'page',
      blocks: blocks as never,
    });
  const ids = (blocks: readonly Block[]) => blocks.map((b) => b.id);
  const texts = (blocks: readonly Block[]) =>
    blocks.map((b) => (b.type === 'heading' ? b.props.text.nl : b.type));

  it('puts a copy in pattern order at every kind of place, with new ids and the names kept', async () => {
    const saved = await pattern([
      { ...heading(undefined, 'Eén'), name: { nl: 'Kop' } },
      { ...heading(undefined, 'Twee'), name: { nl: 'Slot' } },
    ]);
    const { item, revision } = await create([heading('x', 'X'), heading('y', 'Y')]);
    let base = revision.id;
    for (const [place, expected] of [
      [{ at: 'start' }, ['Eén', 'Twee', 'X', 'Y']],
      [{ before: 'y' }, ['Eén', 'Twee', 'X', 'Eén', 'Twee', 'Y']],
      [{ after: 'x' }, ['Eén', 'Twee', 'X', 'Eén', 'Twee', 'Eén', 'Twee', 'Y']],
      [{ at: 'end' }, ['Eén', 'Twee', 'X', 'Eén', 'Twee', 'Eén', 'Twee', 'Y', 'Eén', 'Twee']],
    ] as const) {
      const out = await invoker.run(useCases.insertPattern, admin, {
        itemId: item.id,
        baseRevisionId: base,
        patternId: saved.id,
        place,
      });
      base = out.revision.id;
      const blocks = out.revision.document.blocks;
      expect(texts(blocks)).toEqual(expected);
      expect(out.created).toHaveLength(2);
      for (const id of out.created) expect(ids(saved.blocks)).not.toContain(id);
      expect(out.created.map((id) => blocks.find((b) => b.id === id)?.name)).toEqual([
        { nl: 'Kop' },
        { nl: 'Slot' },
      ]);
      expect(out).toMatchObject({ retired: [], merged: [] });
    }
    // One revision per insert, and the pattern itself is untouched.
    const { revisions } = await invoker.run(useCases.listRevisions, admin, { itemId: item.id });
    expect(revisions).toHaveLength(5);
    const after = await invoker.run(useCases.getPattern, admin, { patternId: saved.id });
    expect(after.blocks).toEqual(saved.blocks);
  });

  it('merges prose at both edges into the text before it, reporting only ids that existed', async () => {
    const saved = await pattern([
      prose(undefined, 'P1', 'P1'),
      heading(undefined, 'Mid'),
      prose(undefined, 'P2', 'P2'),
    ]);
    const { item, revision } = await create([
      prose('a', 'A', 'A'),
      heading('h', 'H'),
      prose('c', 'C', 'C'),
    ]);
    const out = await invoker.run(useCases.insertPattern, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      patternId: saved.id,
      place: { after: 'h' },
    });
    const blocks = out.revision.document.blocks;
    // `h` then the pattern's first prose (new), the heading, the pattern's last prose which takes
    // `c` in: `c` is the one existing id that went.
    expect(texts(blocks)).toEqual(['rich-text', 'H', 'rich-text', 'Mid', 'rich-text']);
    expect(blocks[0]!.id).toBe('a');
    expect(out.created).toEqual([blocks[2]!.id, blocks[3]!.id, blocks[4]!.id]);
    expect(out.retired).toEqual(['c']);
    expect(out.merged).toEqual([{ from: 'c', into: blocks[4]!.id }]);
    const last = blocks[4]!;
    expect(last.type === 'rich-text' && last.props.content.nl!.content).toEqual([
      para('P2'),
      para('C'),
    ]);
  });

  it('rebases on an older base when its place is unchanged, and conflicts when it moved', async () => {
    const saved = await pattern([heading(undefined, 'P')]);
    const { item, revision } = await create([heading('x', 'X'), heading('y', 'Y')]);
    const elsewhere = await invoker.run(useCases.insertBlock, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      block: heading(undefined, 'Z'),
      place: { at: 'end' },
    });
    const rebased = await invoker.run(useCases.insertPattern, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      patternId: saved.id,
      place: { after: 'x' },
    });
    expect(texts(rebased.revision.document.blocks)).toEqual(['X', 'P', 'Y', 'Z']);
    expect(rebased.revision.provenance).toMatchObject({
      merged: { baseRevisionId: revision.id, latestRevisionId: elsewhere.revision.id },
    });
    await invoker.run(useCases.insertBlock, admin, {
      itemId: item.id,
      baseRevisionId: rebased.revision.id,
      block: heading(undefined, 'Q'),
      place: { before: 'y' },
    });
    await expect(
      invoker.run(useCases.insertPattern, admin, {
        itemId: item.id,
        baseRevisionId: rebased.revision.id,
        patternId: saved.id,
        place: { before: 'y' },
      })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('answers an unknown pattern with not_found and an unknown anchor with invalid_input', async () => {
    const saved = await pattern([heading(undefined, 'P')]);
    const { item, revision } = await create([heading('x', 'X')]);
    const target = { itemId: item.id, baseRevisionId: revision.id };
    await expect(
      invoker.run(useCases.insertPattern, admin, {
        ...target,
        patternId: '01900000-0000-7000-8000-0000000000ff',
        place: { at: 'end' },
      })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      invoker.run(useCases.insertPattern, admin, {
        ...target,
        patternId: saved.id,
        place: { after: 'nope' },
      })
    ).rejects.toMatchObject({
      code: 'invalid_input',
      issues: [{ path: 'after', message: 'content.block.unknown' }],
    });
  });
});
