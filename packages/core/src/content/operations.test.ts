// Block operations and discovery in memory (ADR 020 rules 4, 6 and 7): id preservation, the
// created/retired/merged report, lossless normalisation, split-and-insert, typed refusals, block
// switches, and `content.item.find` with draft/live separation. A fast-check sequence of
// operations checks the tree invariants after every step. The database conformance repeats the
// lock, the refs table and RLS against Postgres.

import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ENTITLEMENTS } from '../entitlements/model.js';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal, systemPrincipal, type Principal } from '../principal.js';
import { MemoryUnitOfWork, probeForm, TENANT } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { blockTreeIssues, type Block } from './blocks.js';
import { ContentDocument } from './model.js';

const FORM = '01900000-0000-7000-8000-00000000f000';

const para = (t: string, marks?: object[]) => ({
  type: 'paragraph' as const,
  content: [{ type: 'text' as const, text: t, ...(marks ? { marks } : {}) }],
});
const heading = (t: string) => ({
  type: 'heading' as const,
  attrs: { level: 1 as const },
  content: [{ type: 'text' as const, text: t }],
});
const doc = (...content: object[]) => ({ type: 'doc' as const, content });
const richText = (id: string, content: Record<string, object>) => ({
  id,
  type: 'rich-text' as const,
  version: 1 as const,
  props: { content },
});
const headingBlock = (id: string, nl = 'Kop', en = 'Heading') => ({
  id,
  type: 'heading' as const,
  version: 1 as const,
  props: { text: { nl, en } },
});
const signup = (id: string) => ({
  id,
  type: 'signup-form' as const,
  version: 1 as const,
  props: { formId: FORM },
});

/** Two text blocks around a card, both locales, with marks, attrs and a heading inside. */
const sample = () => [
  richText('a', {
    nl: doc(heading('Begin'), para('Een', [{ type: 'bold' }])),
    en: doc(heading('Start'), para('One', [{ type: 'bold' }])),
  }),
  headingBlock('card'),
  richText('b', {
    nl: doc(para('Twee', [{ type: 'link', attrs: { href: 'https://example.org/' } }])),
    en: doc(para('Two', [{ type: 'link', attrs: { href: 'https://example.org/' } }])),
  }),
  signup('form'),
];

describe('block operations', () => {
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let admin: Principal;

  beforeEach(async () => {
    uow = new MemoryUnitOfWork();
    invoker = new Invoker(buildRegistry(), uow);
    admin = systemPrincipal(TENANT, 'test');
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(FORM)));
  });

  const create = async (blocks: object[] = sample(), slug = 'page') =>
    invoker.run(useCases.createItem, admin, {
      slug,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Titel', en: 'Title' },
        blocks,
      } as never,
    });
  const ids = (blocks: readonly Block[]) => blocks.map((b) => b.id);
  const revisionCount = async (itemId: string) =>
    (await invoker.run(useCases.listRevisions, admin, { itemId })).revisions.length;

  it('inserts a new block next to an id, keeping every other id', async () => {
    const { item, revision } = await create();
    const out = await invoker.run(useCases.insertBlock, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      block: { type: 'heading', version: 1, props: { text: { nl: 'Nieuw' } } },
      place: { after: 'card' },
    });
    const added = out.created[0]!;
    expect(ids(out.revision.document.blocks)).toEqual(['a', 'card', added, 'b', 'form']);
    expect(out).toMatchObject({ retired: [], merged: [] });
    expect(out.item.latestRevisionId).toBe(out.revision.id);
    // A caller-chosen id is kept when free, refused when taken.
    const named = await invoker.run(useCases.insertBlock, admin, {
      itemId: item.id,
      baseRevisionId: out.revision.id,
      block: { ...headingBlock('mine'), version: 1 },
      place: { at: 'start' },
    });
    expect(named.created).toEqual(['mine']);
    await expect(
      invoker.run(useCases.insertBlock, admin, {
        itemId: item.id,
        baseRevisionId: named.revision.id,
        block: headingBlock('card'),
        place: { at: 'end' },
      })
    ).rejects.toMatchObject({
      code: 'invalid_input',
      issues: [{ path: 'block.id', message: 'content.block-id.duplicate' }],
    });
  });

  it('refuses an insert that would put two text blocks side by side, as update does', async () => {
    const { item, revision } = await create();
    await expect(
      invoker.run(useCases.insertBlock, admin, {
        itemId: item.id,
        baseRevisionId: revision.id,
        block: richText('c', { nl: doc(para('x')), en: doc(para('x')) }),
        place: { after: 'a' },
      })
    ).rejects.toMatchObject({
      code: 'invalid_input',
      issues: [expect.objectContaining({ message: 'content.blocks.adjacent-rich-text' })],
    });
    expect(await revisionCount(item.id)).toBe(1);
  });

  it('moves by id, and merges the text the move brings together into the first block', async () => {
    const { item, revision } = await create();
    const out = await invoker.run(useCases.moveBlock, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      blockId: 'card',
      place: { at: 'end' },
    });
    // The card leaving brings 'a' and 'b' together.
    expect(ids(out.revision.document.blocks)).toEqual(['a', 'form', 'card']);
    expect(out).toMatchObject({ created: [], retired: ['b'], merged: [{ from: 'b', into: 'a' }] });
    const merged = out.revision.document.blocks[0]!;
    // Lossless: every node of both blocks in order, per locale, marks and heading attrs intact.
    expect(merged.props).toEqual({
      content: {
        nl: doc(
          heading('Begin'),
          para('Een', [{ type: 'bold' }]),
          para('Twee', [{ type: 'link', attrs: { href: 'https://example.org/' } }])
        ),
        en: doc(
          heading('Start'),
          para('One', [{ type: 'bold' }]),
          para('Two', [{ type: 'link', attrs: { href: 'https://example.org/' } }])
        ),
      },
    });
  });

  it('keeps id and type on set_props and validates the props against that block type', async () => {
    const { item, revision } = await create();
    const out = await invoker.run(useCases.setBlockProps, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      blockId: 'card',
      props: { text: { nl: 'Andere kop' } },
    });
    expect(out.revision.document.blocks[1]).toEqual({
      ...headingBlock('card'),
      props: { text: { nl: 'Andere kop' } },
    });
    expect(out).toMatchObject({ created: [], retired: [], merged: [] });
    await expect(
      invoker.run(useCases.setBlockProps, admin, {
        itemId: item.id,
        baseRevisionId: out.revision.id,
        blockId: 'card',
        props: { formId: FORM },
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('removes by id and reports the removed and the merged-away ids', async () => {
    const { item, revision } = await create();
    const out = await invoker.run(useCases.removeBlock, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      blockId: 'card',
    });
    expect(ids(out.revision.document.blocks)).toEqual(['a', 'form']);
    expect(out).toMatchObject({
      created: [],
      retired: ['card', 'b'],
      merged: [{ from: 'b', into: 'a' }],
    });
  });

  it('fails closed when two text blocks to merge do not have the same locales', async () => {
    const { item, revision } = await create([
      richText('a', { nl: doc(para('Alleen nl')) }),
      headingBlock('card'),
      richText('b', { nl: doc(para('nl')), en: doc(para('en')) }),
    ]);
    await expect(
      invoker.run(useCases.removeBlock, admin, {
        itemId: item.id,
        baseRevisionId: revision.id,
        blockId: 'card',
      })
    ).rejects.toMatchObject({
      code: 'invalid_input',
      issues: [{ path: 'blockId', message: 'content.blocks.merge-ambiguous:a' }],
    });
    expect(await revisionCount(item.id)).toBe(1);
  });

  it('splits a text block in every locale around a new card; the first part keeps the id', async () => {
    const { item, revision } = await create([
      richText('t', {
        nl: doc(para('1'), para('2'), para('3')),
        en: doc(para('one'), para('two')),
      }),
    ]);
    const out = await invoker.run(useCases.splitInsertBlock, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      blockId: 't',
      at: { nl: 2, en: 1 },
      block: { type: 'heading', version: 1, props: { text: { nl: 'Tussen', en: 'Between' } } },
    });
    const [first, card, second] = out.revision.document.blocks;
    expect(first).toEqual(richText('t', { nl: doc(para('1'), para('2')), en: doc(para('one')) }));
    expect(card).toMatchObject({ id: out.created[0], type: 'heading' });
    expect(second).toEqual(richText(out.created[1]!, { nl: doc(para('3')), en: doc(para('two')) }));
    expect(out).toMatchObject({ retired: [], merged: [] });
  });

  it('upgrades a legacy field marker to locale review across a split', async () => {
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug: 'translated-split',
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Titel', en: 'Title' },
        blocks: [
          richText('t', {
            nl: doc(para('Een'), para('Twee')),
            en: doc(para('One'), para('Two')),
          }),
        ],
        machineTranslation: { en: ['blocks.t.props.content'] },
      },
    });
    const out = await invoker.run(useCases.splitInsertBlock, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      blockId: 't',
      at: { nl: 1, en: 1 },
      block: headingBlock('between'),
    });
    expect(out.revision.document.machineTranslation?.en).toEqual(['locales']);
    await expect(
      invoker.run(useCases.publishItem, admin, {
        itemId: item.id,
        revisionId: out.revision.id,
        locale: 'en',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it.each([
    [{ nl: 0, en: 1 }, 'at.nl', 'content.split.empty-part'],
    [{ nl: 1, en: 2 }, 'at.en', 'content.split.empty-part'],
    [{ nl: 1 }, 'at.en', 'content.split.locale-missing'],
    [{ nl: 1, en: 1, de: 1 }, 'at.de', 'content.split.locale-unknown'],
  ])('refuses a split at %o (%s: %s)', async (at, path, message) => {
    const { item, revision } = await create([
      richText('t', { nl: doc(para('1'), para('2')), en: doc(para('one'), para('two')) }),
    ]);
    await expect(
      invoker.run(useCases.splitInsertBlock, admin, {
        itemId: item.id,
        baseRevisionId: revision.id,
        blockId: 't',
        at,
        block: { type: 'paywall', version: 1, props: {} },
      })
    ).rejects.toMatchObject({ code: 'invalid_input', issues: [{ path, message }] });
  });

  it('never commits adjacent text blocks through a split: a text block in between is refused', async () => {
    const { item, revision } = await create([
      richText('t', { nl: doc(para('1'), para('2')), en: doc(para('one'), para('two')) }),
    ]);
    await expect(
      invoker.run(useCases.splitInsertBlock, admin, {
        itemId: item.id,
        baseRevisionId: revision.id,
        blockId: 't',
        at: { nl: 1, en: 1 },
        block: { type: 'rich-text', version: 1, props: { content: { nl: doc(para('x')) } } },
      })
    ).rejects.toMatchObject({
      code: 'invalid_input',
      issues: expect.arrayContaining([
        expect.objectContaining({ message: 'content.blocks.adjacent-rich-text' }),
      ]),
    });
    await expect(
      invoker.run(useCases.splitInsertBlock, admin, {
        itemId: item.id,
        baseRevisionId: revision.id,
        blockId: 't',
        at: { nl: 1, en: 1 },
        block: headingBlock('t'),
      })
    ).rejects.toMatchObject({ issues: [{ path: 'block.id' }] });
    expect(await revisionCount(item.id)).toBe(1);
  });

  it('answers an unknown id or anchor with invalid_input on that field, never not_found', async () => {
    const { item, revision } = await create();
    const base = { itemId: item.id, baseRevisionId: revision.id };
    const refusals = [
      invoker.run(useCases.removeBlock, admin, { ...base, blockId: 'nope' }),
      invoker.run(useCases.moveBlock, admin, { ...base, blockId: 'nope', place: { at: 'end' } }),
      invoker.run(useCases.moveBlock, admin, { ...base, blockId: 'a', place: { before: 'nope' } }),
      invoker.run(useCases.moveBlock, admin, { ...base, blockId: 'a', place: { after: 'a' } }),
      invoker.run(useCases.insertBlock, admin, {
        ...base,
        block: { type: 'paywall', version: 1, props: {} },
        place: { after: 'nope' },
      }),
      invoker.run(useCases.setBlockProps, admin, { ...base, blockId: 'nope', props: {} }),
      invoker.run(useCases.splitInsertBlock, admin, {
        ...base,
        blockId: 'card',
        at: {},
        block: { type: 'paywall', version: 1, props: {} },
      }),
    ];
    const results = await Promise.allSettled(refusals);
    expect(
      results.map((r) =>
        r.status === 'rejected'
          ? [r.reason.code, r.reason.issues[0].path, r.reason.issues[0].message]
          : r
      )
    ).toEqual([
      ['invalid_input', 'blockId', 'content.block.unknown:nope'],
      ['invalid_input', 'blockId', 'content.block.unknown:nope'],
      ['invalid_input', 'before', 'content.block.unknown:nope'],
      ['invalid_input', 'after', 'content.block.anchor-is-target'],
      ['invalid_input', 'after', 'content.block.unknown:nope'],
      ['invalid_input', 'blockId', 'content.block.unknown:nope'],
      ['invalid_input', 'blockId', 'content.split.not-rich-text'],
    ]);
    expect(await revisionCount(item.id)).toBe(1);
  });

  it('refuses every operation on a stale base with conflict and writes nothing', async () => {
    const { item, revision } = await create();
    const fresh = await invoker.run(useCases.removeBlock, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      blockId: 'form',
    });
    const stale = { itemId: item.id, baseRevisionId: revision.id };
    for (const call of [
      () => invoker.run(useCases.removeBlock, admin, { ...stale, blockId: 'card' }),
      () =>
        invoker.run(useCases.moveBlock, admin, {
          ...stale,
          blockId: 'card',
          place: { at: 'start' },
        }),
      () =>
        invoker.run(useCases.insertBlock, admin, {
          ...stale,
          block: { type: 'paywall', version: 1, props: {} },
          place: { at: 'end' },
        }),
      () => invoker.run(useCases.setBlockProps, admin, { ...stale, blockId: 'card', props: {} }),
      () =>
        invoker.run(useCases.splitInsertBlock, admin, {
          ...stale,
          blockId: 'a',
          at: { nl: 1, en: 1 },
          block: { type: 'paywall', version: 1, props: {} },
        }),
    ])
      await expect(call()).rejects.toMatchObject({
        code: 'conflict',
        issues: [
          { path: 'baseRevisionId', message: `content.revision.conflict:${fresh.revision.id}` },
        ],
      });
    expect(await revisionCount(item.id)).toBe(2);
  });

  it('refuses a switched-off block type on item and pattern writes (ADR 015)', async () => {
    const { item, revision } = await create();
    const off = systemPrincipal(TENANT, 'test', {
      entitlements: { ...DEFAULT_ENTITLEMENTS, blocks: { 'signup-form': false } },
      status: 'active',
    });
    const refused = { code: 'limit_exceeded', issues: [{ message: 'entitlements.feature_off' }] };
    await expect(
      invoker.run(useCases.setBlockProps, off, {
        itemId: item.id,
        baseRevisionId: revision.id,
        blockId: 'card',
        props: { text: { nl: 'x' } },
      })
    ).rejects.toMatchObject(refused);
    await expect(
      invoker.run(useCases.createItem, off, {
        slug: 'third',
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: 'x' },
          blocks: [signup('f')],
        },
      })
    ).rejects.toMatchObject(refused);
    await expect(
      invoker.run(useCases.createPattern, off, {
        name: { nl: 'Actie' },
        intendedType: 'page',
        blocks: [signup('f')],
      })
    ).rejects.toMatchObject(refused);
    // Without the switched-off type, the same principal writes as before.
    await expect(
      invoker.run(useCases.createPattern, off, {
        name: { nl: 'Kop' },
        intendedType: 'page',
        blocks: [headingBlock('h')],
      })
    ).resolves.toBeDefined();
  });
});

describe('block operations, random sequences', () => {
  // fast-check draws each choice as the sequence runs (as in lifecycle.test.ts); a failure is
  // shrunk and printed with the seed and path that replay it.
  async function runSequence(g: fc.GeneratorValue, steps: number): Promise<void> {
    const pick = <T>(xs: readonly T[]): T => g(fc.constantFrom, ...xs);
    const uow = new MemoryUnitOfWork();
    const invoker = new Invoker(buildRegistry(), uow);
    const admin = systemPrincipal(TENANT, 'property');
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(FORM)));
    let { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug: 'p',
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'T', en: 'T' },
        blocks: sample(),
      } as never,
    });
    let n = 0;
    const text = () => `t${(n += 1)}`;
    const card = () =>
      pick([
        { type: 'heading' as const, version: 1 as const, props: { text: { nl: text() } } },
        { type: 'signup-form' as const, version: 1 as const, props: { formId: FORM } },
      ]);
    for (let step = 0; step < steps; step += 1) {
      const blocks = revision.document.blocks;
      const base = { itemId: item.id, baseRevisionId: revision.id };
      const target = pick(blocks.length ? blocks : [{ id: 'none' } as Block]).id;
      const placement = pick([
        { at: 'start' as const },
        { at: 'end' as const },
        { before: target },
        { after: pick(blocks.length ? blocks : [{ id: 'none' } as Block]).id },
      ]);
      const texts = blocks.filter((b) => b.type === 'rich-text');
      const op = pick(['insert', 'insert-text', 'move', 'remove', 'split'] as const);
      const call = async () => {
        if (op === 'insert')
          return invoker.run(useCases.insertBlock, admin, {
            ...base,
            block: card(),
            place: placement,
          });
        if (op === 'insert-text')
          return invoker.run(useCases.insertBlock, admin, {
            ...base,
            block: {
              type: 'rich-text',
              version: 1,
              props: {
                content: {
                  nl: doc(para(text()), para(text())),
                  en: doc(para(text()), para(text())),
                },
              },
            },
            place: placement,
          });
        if (op === 'move')
          return invoker.run(useCases.moveBlock, admin, {
            ...base,
            blockId: target,
            place: placement,
          });
        if (op === 'remove')
          return invoker.run(useCases.removeBlock, admin, { ...base, blockId: target });
        const t = pick(texts.length ? texts : [{ id: 'none' } as Block]);
        const len = (l: string) =>
          t.type === 'rich-text' ? (t.props.content[l]?.content.length ?? 0) : 0;
        return invoker.run(useCases.splitInsertBlock, admin, {
          ...base,
          blockId: t.id,
          at: {
            nl: g(fc.integer, { min: 1, max: Math.max(1, len('nl') - 1) }),
            en: g(fc.integer, { min: 1, max: Math.max(1, len('en') - 1) }),
          },
          block: card(),
        });
      };
      const before = new Set(blocks.map((b) => b.id));
      try {
        const out = await call();
        const after = out.revision.document.blocks;
        // Invariants: a valid stored document, unique ids, no adjacent text, and the report
        // accounts for every id that appeared or disappeared.
        ContentDocument.parse(out.revision.document);
        expect(blockTreeIssues(after)).toEqual([]);
        const now = new Set(after.map((b) => b.id));
        expect(now.size).toBe(after.length);
        expect([...now].filter((id) => !before.has(id)).sort()).toEqual([...out.created].sort());
        expect([...before].filter((id) => !now.has(id)).sort()).toEqual([...out.retired].sort());
        for (const m of out.merged) expect(now.has(m.into)).toBe(true);
        ({ item, revision } = out);
      } catch (e) {
        // Refusals are typed and write nothing.
        expect((e as { code?: string }).code).toBe('invalid_input');
        const latest = await invoker.run(useCases.getItem, admin, { itemId: item.id });
        expect(latest.item.latestRevisionId).toBe(revision.id);
      }
    }
  }

  it('keeps the tree invariants for 40 random steps', async () => {
    await fc.assert(
      fc.asyncProperty(fc.gen(), (g) => runSequence(g, 40)),
      { numRuns: 25 }
    );
  });
});

describe('content.item.find and live references', () => {
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let admin: Principal;

  beforeEach(async () => {
    uow = new MemoryUnitOfWork();
    invoker = new Invoker(buildRegistry(), uow);
    admin = systemPrincipal(TENANT, 'test');
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(FORM)));
  });

  const page = (slug: string, blocks: object[]) =>
    invoker.run(useCases.createItem, admin, {
      slug,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: slug },
        blocks,
      } as never,
    });
  const find = (input: object) => invoker.run(useCases.findItems, admin, input as never);
  const live = (type: 'form' | 'item' | 'author' | 'section', id: string) =>
    uow.run(admin, (ctx) => ctx.content.liveReferences({ type, id }));

  it('finds by block type and by every kind of reference, with the matching block ids', async () => {
    const target = await page('target', []);
    const author = await invoker.run(useCases.createAuthor, admin, { slug: 'sam', name: 'Sam' });
    const section = await invoker.run(useCases.createSection, admin, {
      slug: 's',
      title: { nl: 'S' },
    });
    const linking = await page('linking', [
      richText('l', {
        nl: doc(para('zie', [{ type: 'link', attrs: { itemId: target.item.id } }])),
      }),
      signup('f'),
    ]);
    const article = await invoker.run(useCases.createItem, admin, {
      slug: 'story',
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Verhaal' },
        blocks: [],
        authorIds: [author.id],
        sectionId: section.id,
      },
    });
    const hit = async (input: object) =>
      (await find(input)).matches.map((m) => [m.itemId, m.blockIds]);
    expect(await hit({ blockType: 'signup-form' })).toEqual([[linking.item.id, ['f']]]);
    expect(await hit({ ref: { type: 'form', id: FORM } })).toEqual([[linking.item.id, ['f']]]);
    expect(await hit({ ref: { type: 'item', id: target.item.id } })).toEqual([
      [linking.item.id, ['l']],
    ]);
    expect(await hit({ ref: { type: 'author', id: author.id } })).toEqual([[article.item.id, []]]);
    expect(await hit({ ref: { type: 'section', id: section.id } })).toEqual([
      [article.item.id, []],
    ]);
    expect(await hit({ blockType: 'signup-form', type: 'article' })).toEqual([]);
    expect(await hit({ blockType: 'paywall' })).toEqual([]);
    await expect(find({})).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('with live, follows the publication pointers instead of the latest draft', async () => {
    // Live without the form, draft with it: found as draft, not live.
    const a = await page('a', [{ ...headingBlock('h'), props: { text: { nl: 'Kop' } } }]);
    await invoker.run(useCases.publishItem, admin, {
      itemId: a.item.id,
      revisionId: a.revision.id,
      locale: 'nl',
    });
    await invoker.run(useCases.insertBlock, admin, {
      itemId: a.item.id,
      baseRevisionId: a.revision.id,
      block: signup('f'),
      place: { at: 'end' },
    });
    // Live with the form, draft without it: found live, not as draft.
    const b = await page('b', [signup('f')]);
    await invoker.run(useCases.publishItem, admin, {
      itemId: b.item.id,
      revisionId: b.revision.id,
      locale: 'nl',
    });
    await invoker.run(useCases.removeBlock, admin, {
      itemId: b.item.id,
      baseRevisionId: b.revision.id,
      blockId: 'f',
    });
    const ref = { type: 'form', id: FORM };
    expect((await find({ ref })).items.map((i) => i.slug)).toEqual(['a']);
    expect((await find({ ref, live: true })).items.map((i) => i.slug)).toEqual(['b']);
    expect((await find({ blockType: 'signup-form', live: true })).items.map((i) => i.slug)).toEqual(
      ['b']
    );
    expect(await live('form', FORM)).toBe(1);
    await invoker.run(useCases.unpublishItem, admin, { itemId: b.item.id, locale: 'nl' });
    expect(await live('form', FORM)).toBe(0);
  });

  it('pages newest first and never answers an anonymous principal', async () => {
    for (const slug of ['p1', 'p2', 'p3']) await page(slug, [signup('f')]);
    const first = await find({ blockType: 'signup-form', limit: 2 });
    expect(first.items.map((i) => i.slug)).toEqual(['p3', 'p2']);
    const rest = await find({ blockType: 'signup-form', limit: 2, after: first.next });
    expect(rest).toMatchObject({ next: null, items: [{ slug: 'p1' }] });
    await expect(
      invoker.run(
        useCases.findItems,
        anonymousPrincipal(TENANT, ['content:read', 'content:write', 'content:publish']),
        { blockType: 'signup-form' }
      )
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
