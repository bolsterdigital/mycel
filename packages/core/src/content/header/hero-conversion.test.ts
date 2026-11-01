// The legacy hero conversion (ADR 025 rules 5 and 6) in memory: every case of the brief's
// acceptance list, a refusal that writes nothing, and a property over generated documents: either
// nothing is written, or every text, reference and locale of the hero is still in the document.

import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import { systemPrincipal, type Principal } from '../../principal.js';
import { MemoryUnitOfWork, TENANT } from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';
import { ContentDocument } from '../model.js';
import { applyHeroConversion, proposeHeroConversion } from './hero-conversion.js';

const MEDIA = '01900000-0000-7000-8000-00000000a001';
const OTHER = '01900000-0000-7000-8000-00000000a002';
const ITEM = '01900000-0000-7000-8000-00000000a003';

const hero = (props: object = {}, id = 'hero') => ({
  id,
  type: 'hero' as const,
  version: 1 as const,
  props: { title: { nl: 'Schone lucht', en: 'Clean air' }, ...props },
});
const text = (id: string) => ({
  id,
  type: 'heading' as const,
  version: 1 as const,
  props: { text: { nl: 'Kop', en: 'Heading' } },
});
const image = (over: object = {}) => ({
  mediaId: MEDIA,
  decorative: false,
  alt: { nl: 'Een plein', en: 'A square' },
  ...over,
});
const action = {
  label: { nl: 'Lees', en: 'Read' },
  target: { kind: 'item' as const, itemId: ITEM },
};
const document = (blocks: object[], over: object = {}) =>
  ContentDocument.parse({
    type: 'page',
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl: 'Schone lucht', en: 'Clean air' },
    blocks,
    ...over,
  });
const codes = (doc: ContentDocument) =>
  proposeHeroConversion(doc)?.conflicts.map((c) => c.code) ?? [];

describe('proposeHeroConversion', () => {
  it('has nothing to say without a hero', () => {
    expect(proposeHeroConversion(document([text('a')]))).toBeNull();
  });

  it('fills an empty header from a leading hero, in every locale', () => {
    const doc = document(
      [
        hero({
          title: { nl: 'Schone lucht', en: 'Clean air' },
          body: { nl: 'Doe mee', en: 'Join' },
          image: image(),
        }),
        text('a'),
      ],
      { title: { nl: 'Schone lucht' } }
    );
    const conversion = proposeHeroConversion(doc)!;
    expect(conversion.conflicts).toEqual([]);
    const next = applyHeroConversion(doc, conversion, 'unused');
    expect(next.title).toEqual({ nl: 'Schone lucht', en: 'Clean air' });
    expect(next.lead).toEqual({ nl: 'Doe mee', en: 'Join' });
    expect(next.heroImageId).toBe(MEDIA);
    expect(next.heroAlt).toEqual({ nl: 'Een plein', en: 'A square' });
    expect(next.blocks.map((b) => b.id)).toEqual(['a']);
    expect(() => ContentDocument.parse(next)).not.toThrow();
  });

  it('accepts equal values and keeps what the header has beyond the hero', () => {
    const doc = document([hero({ body: { nl: 'Doe mee' }, image: image() })], {
      lead: { nl: 'Doe mee', en: 'Join' },
      heroImageId: MEDIA,
      heroAlt: { nl: 'Een plein', en: 'A square' },
    });
    expect(codes(doc)).toEqual([]);
    const next = applyHeroConversion(doc, proposeHeroConversion(doc)!, 'unused');
    expect(next.lead).toEqual({ nl: 'Doe mee', en: 'Join' });
  });

  it.each([
    [
      'a different title',
      document([hero()], { title: { nl: 'Anders', en: 'Clean air' } }),
      'title',
    ],
    ['a different lead', document([hero({ body: { nl: 'A' } })], { lead: { nl: 'B' } }), 'lead'],
    [
      'a different image',
      document([hero({ image: image({ decorative: true, alt: null }) })], { heroImageId: OTHER }),
      'image',
    ],
    [
      'a different description',
      document([hero({ image: image() })], {
        heroImageId: MEDIA,
        heroAlt: { nl: 'Iets anders', en: 'A square' },
      }),
      'alt',
    ],
    ['several heroes', document([hero(), text('a'), hero({}, 'two')]), 'several-heroes'],
    ['a hero after another block', document([text('a'), hero()]), 'not-first'],
    [
      'an own caption',
      document([hero({ image: image({ caption: { nl: 'Op het plein' } }) })]),
      'caption',
    ],
    [
      'an empty caption, which hides the asset',
      document([hero({ image: image({ caption: { nl: '' } }) })]),
      'caption',
    ],
    [
      'an own credit',
      document([hero({ image: image({ credit: { work: null, photographer: 'Sam' } }) })]),
      'credit',
    ],
    [
      'a body longer than a lead',
      document([hero({ body: { nl: 'x'.repeat(1001) } })]),
      'lead-too-long',
    ],
  ])('calls %s a conflict', (_name, doc, code) => {
    expect(codes(doc)).toContain(code);
  });

  it('inherits an absent caption without a conflict', () => {
    expect(codes(document([hero({ image: image() })]))).toEqual([]);
  });

  it('turns actions into a CTA at the same place, with their references', () => {
    const doc = document([
      hero({ actions: [action], width: 'wide', align: 'center', variant: 'minimal' }),
      text('a'),
    ]);
    const conversion = proposeHeroConversion(doc)!;
    const next = applyHeroConversion(doc, conversion, 'made');
    expect(next.blocks.map((b) => [b.id, b.type])).toEqual([
      ['made', 'cta'],
      ['a', 'heading'],
    ]);
    expect(next.blocks[0]!.props).toMatchObject({
      actions: [action],
      width: 'wide',
      align: 'center',
    });
    expect(() => ContentDocument.parse(next)).not.toThrow();
  });

  it('never lets a block teaser grow into paid content', () => {
    const paid = (blocks: object[], n: number) =>
      document(blocks, {
        access: { level: 'members', teaser: { blocks: n } },
      });
    const without = paid([hero(), text('a'), text('b')], 1);
    const conversion = proposeHeroConversion(without)!;
    expect(conversion.teaser).toEqual({ from: 1, to: 0 });
    expect(applyHeroConversion(without, conversion, 'x').access.teaser).toEqual({ blocks: 0 });
    // The CTA takes the hero's place in the count, so the same blocks stay behind the line.
    const withCta = paid([hero({ actions: [action] }), text('a'), text('b')], 1);
    expect(proposeHeroConversion(withCta)!.teaser).toBeNull();
    expect(
      applyHeroConversion(withCta, proposeHeroConversion(withCta)!, 'x').access.teaser
    ).toEqual({ blocks: 1 });
  });

  it('reports the block layout that the header does not take over', () => {
    const doc = document([hero({ variant: 'cover', image: image(), width: 'wide' })]);
    expect(proposeHeroConversion(doc)!.layout).toEqual({
      variant: 'cover',
      width: 'wide',
      align: 'start',
    });
  });

  it('loses nothing, or refuses', () => {
    const word = fc.constantFrom('een', 'twee', 'drie');
    const optional = fc.option(word, { nil: undefined });
    fc.assert(
      fc.property(
        word,
        optional,
        optional,
        word,
        optional,
        (heroNl, heroEn, body, headNl, lead) => {
          const doc = document(
            [
              hero({
                title: { nl: heroNl, ...(heroEn ? { en: heroEn } : {}) },
                ...(body ? { body: { nl: body } } : {}),
                actions: heroEn ? [action] : [],
              }),
            ],
            { title: { nl: headNl }, ...(lead ? { lead: { nl: lead } } : {}) }
          );
          const conversion = proposeHeroConversion(doc)!;
          const differs = heroNl !== headNl || (!!body && !!lead && body !== lead);
          expect(conversion.conflicts.length > 0).toBe(differs);
          if (differs) return;
          const next = ContentDocument.parse(applyHeroConversion(doc, conversion, 'made'));
          expect(next.title['nl']).toBe(heroNl);
          if (heroEn) expect(next.title['en']).toBe(heroEn);
          if (body) expect(next.lead?.['nl']).toBe(body);
          if (lead) expect(next.lead?.['nl']).toBe(lead);
          expect(next.blocks.some((b) => b.type === 'hero')).toBe(false);
          if (heroEn) expect(next.blocks[0]!.props).toMatchObject({ actions: [action] });
        }
      )
    );
  });
});

describe('content.hero.convert', () => {
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let admin: Principal;

  beforeEach(() => {
    uow = new MemoryUnitOfWork();
    invoker = new Invoker(buildRegistry(), uow);
    admin = systemPrincipal(TENANT, 'test');
  });

  const create = (blocks: object[], over: object = {}) =>
    invoker.run(useCases.createItem, admin, {
      slug: 'page',
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Schone lucht', en: 'Clean air' },
        blocks,
        ...over,
      } as never,
    });
  const revisions = async (itemId: string) =>
    (await invoker.run(useCases.listRevisions, admin, { itemId })).revisions;

  it('writes one draft revision, reports ids and leaves the published revision alone', async () => {
    const { item, revision } = await create([hero({ body: { nl: 'Doe mee', en: 'Join' } })]);
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
    const done = await invoker.run(useCases.convertHero, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      blockId: 'hero',
    });
    expect(done.retired).toEqual(['hero']);
    expect(done.created).toEqual([]);
    expect(done.revision.document.lead).toEqual({ nl: 'Doe mee', en: 'Join' });
    expect(await revisions(item.id)).toHaveLength(2);
    const live = await invoker.run(useCases.getItem, admin, {
      itemId: item.id,
      revisionId: revision.id,
    });
    expect(live.revision.document.blocks.map((b) => b.type)).toEqual(['hero']);
    expect(done.item.publication.find((p) => p.locale === 'nl')?.publishedRevisionId).toBe(
      revision.id
    );
  });

  it('reports the CTA it made', async () => {
    const { item, revision } = await create([
      hero({ actions: [{ ...action, target: { kind: 'url', url: 'https://example.org/' } }] }),
    ]);
    const done = await invoker.run(useCases.convertHero, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      blockId: 'hero',
    });
    expect(done.created).toHaveLength(1);
    expect(done.revision.document.blocks[0]).toMatchObject({ id: done.created[0], type: 'cta' });
  });

  it('writes nothing on a conflict, a stale base or another block', async () => {
    const { item, revision } = await create([hero(), text('a')], {
      title: { nl: 'Anders', en: 'Other' },
    });
    const input = { itemId: item.id, baseRevisionId: revision.id, blockId: 'hero' };
    await expect(invoker.run(useCases.convertHero, admin, input)).rejects.toMatchObject({
      code: 'invalid_input',
      issues: expect.arrayContaining([
        expect.objectContaining({ message: 'content.hero-conversion.title' }),
      ]),
    });
    await expect(
      invoker.run(useCases.convertHero, admin, { ...input, blockId: 'a' })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      invoker.run(useCases.convertHero, admin, { ...input, baseRevisionId: ITEM })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await revisions(item.id)).toHaveLength(1);
  });

  it('answers the same proposal to an agent as the command applies', async () => {
    const { item, revision } = await create([hero({ body: { nl: 'Doe mee' } })]);
    const { conversion } = await invoker.run(useCases.getHeroConversion, admin, {
      itemId: item.id,
    });
    expect(conversion).toEqual(proposeHeroConversion(revision.document));
  });

  it('refuses while a machine translation waits for review, and keeps the hero', async () => {
    const { item, revision } = await create(
      [hero({ actions: [{ ...action, target: { kind: 'url', url: 'https://example.org/' } }] })],
      { machineTranslation: { en: ['locales'] } }
    );
    await expect(
      invoker.run(useCases.convertHero, admin, {
        itemId: item.id,
        baseRevisionId: revision.id,
        blockId: 'hero',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await revisions(item.id)).toHaveLength(1);
  });
});
