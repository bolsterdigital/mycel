// Block conformance in core (TODO #8b2, testing.md): driven by the registry, so a new type is
// covered by adding its entry. Every example validates, every enumerated value has an example,
// both projections carry only their own locale (a sentinel in the other proves no field leaks),
// readiness asks for every visible field, refusals are typed, and references come out per block.
// Rendering, HTML/Markdown and axe are the renderer's suite (#8c), which imports these examples.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BLOCK_DEFINITIONS,
  BLOCK_TYPES,
  Block,
  BlockInput,
  EXAMPLE_IDS,
  MAX_BLOCKS,
  blockLocalized,
  blockReferenceRows,
  blockTreeIssues,
  projectBlock,
  type BlockField,
  type BlockType,
} from './blocks.js';
import { DEFAULT_ENTITLEMENTS } from '../entitlements/model.js';
import { Invoker } from '../invoke.js';
import { systemPrincipal } from '../principal.js';
import { MemoryUnitOfWork, probeForm } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { ContentDocument, readinessIssues } from './model.js';

const examples = BLOCK_TYPES.flatMap((type) =>
  BLOCK_DEFINITIONS[type].examples.map((e, i) => ({
    type,
    name: e.name,
    input: { id: `${type}-${i}`, type, version: 1, props: e.props } as unknown,
  }))
);
const stored = (input: unknown) => Block.parse(input);

/** The example's document in nl and en, so readiness and projection run on real documents. */
const docOf = (blocks: unknown[]) =>
  ContentDocument.parse({
    type: 'page',
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl: 'Titel', en: 'Title' },
    blocks,
    // A paywall is only valid as the marker teaser of a restricted page.
    ...(blocks.some((b) => (b as { type: string }).type === 'paywall')
      ? { access: { level: 'members', teaser: 'marker' } }
      : {}),
  });

/**
 * Every visible string under an `en` key replaced by a sentinel: the value itself or a `text`
 * node inside it. Ids, URLs and discriminators stay, so the block still parses.
 */
function sentinel(value: unknown, inEn = false, key = ''): unknown {
  if (typeof value === 'string')
    return inEn && (key === 'en' || key === 'text') ? 'LEAK-SENTINEL' : value;
  if (Array.isArray(value)) return value.map((v) => sentinel(v, inEn, ''));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sentinel(v, inEn || k === 'en', k)])
    );
  return value;
}

/** Every localised map of a value: objects whose keys are all locales of the examples. */
function localeKeysOf(value: unknown, out: string[][] = []): string[][] {
  if (Array.isArray(value)) value.forEach((v) => localeKeysOf(v, out));
  else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length && keys.every((k) => k === 'nl' || k === 'en')) out.push(keys);
    Object.values(value).forEach((v) => localeKeysOf(v, out));
  }
  return out;
}

describe('block registry', () => {
  it('lists every type once and gives each version 1 and at least one example', () => {
    expect(new Set(BLOCK_TYPES).size).toBe(BLOCK_TYPES.length);
    for (const type of BLOCK_TYPES) {
      expect(BLOCK_DEFINITIONS[type].version).toBe(1);
      expect(BLOCK_DEFINITIONS[type].examples.length).toBeGreaterThan(0);
    }
  });

  it.each(examples)('$name validates as input and as a stored block', ({ input }) => {
    expect(BlockInput.safeParse(input).success).toBe(true);
    expect(Block.safeParse(input).success).toBe(true);
  });

  it.each(BLOCK_TYPES)('%s has an example for every enumerated value', (type) => {
    const def = BLOCK_DEFINITIONS[type];
    const parsed = examples.filter((e) => e.type === type).map((e) => stored(e.input));
    for (const [field, values] of Object.entries(def.variants))
      for (const value of values)
        expect(
          parsed.some((b) => (b.props as Record<string, unknown>)[field] === value),
          `${type}.${field} = ${value}`
        ).toBe(true);
  });

  it.each(examples)('$name is complete in nl and en: both locales are ready', ({ input }) => {
    const doc = docOf([input]);
    expect(readinessIssues(doc, 'nl')).toEqual([]);
    expect(readinessIssues(doc, 'en')).toEqual([]);
  });

  it('exports JSON Schema for every type through the Zod conversion', async () => {
    const { toJsonSchema } = await import('../json-schema.js');
    const schema = JSON.stringify(toJsonSchema(BlockInput as unknown as z.ZodTypeAny));
    for (const type of BLOCK_TYPES) expect(schema).toContain(`"${type}"`);
  });
});

/** The object shape under defaults, optionals, nullables and refinements, or null for a leaf. */
function shapeOf(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
  if (schema instanceof z.ZodObject) return schema.shape as Record<string, z.ZodTypeAny>;
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  )
    return shapeOf(schema._def.innerType);
  if (schema instanceof z.ZodEffects) return shapeOf(schema._def.schema);
  if (schema instanceof z.ZodArray) return shapeOf(schema.element);
  return null;
}

/** Keys of the shape without a field description, and descriptions without a key, as paths. */
function undescribed(schema: z.ZodTypeAny, fields: readonly BlockField[], at: string): string[] {
  const shape = shapeOf(schema) ?? {};
  const keys = Object.keys(shape);
  const described = fields.map((f) => f.key);
  return [
    ...keys.filter((k) => !described.includes(k)).map((k) => `${at}.${k} has no description`),
    ...described.filter((k) => !keys.includes(k)).map((k) => `${at}.${k} is not in the schema`),
    ...fields.flatMap((f) =>
      (f.kind === 'group' || f.kind === 'list') && shape[f.key]
        ? undescribed(shape[f.key]!, f.fields, `${at}.${f.key}`)
        : []
    ),
  ];
}

describe('field descriptions (brief content-editor § B)', () => {
  it('describes every prop of every type, nested ones included, and nothing else', () => {
    expect(
      BLOCK_TYPES.flatMap((type) =>
        undescribed(BLOCK_DEFINITIONS[type].props, BLOCK_DEFINITIONS[type].fields, type)
      )
    ).toEqual([]);
  });

  it('offers exactly the enumerated values of every choice', () => {
    for (const type of BLOCK_TYPES) {
      const d = BLOCK_DEFINITIONS[type];
      for (const f of d.fields)
        if (f.kind === 'choice' && f.key in d.variants)
          expect(f.options, `${type}.${f.key}`).toEqual(
            (d.variants as Record<string, readonly string[]>)[f.key]
          );
    }
  });
});

describe('locale projection', () => {
  it.each(examples)('$name projected to nl carries nothing of en', ({ input }) => {
    const block = stored(sentinel(input));
    // Not vacuous: a block with localised fields really carries the sentinel before projection.
    if (blockLocalized(block).length) expect(JSON.stringify(block)).toContain('LEAK-SENTINEL');
    const projected = projectBlock(block, 'nl');
    expect(JSON.stringify(projected)).not.toContain('LEAK-SENTINEL');
    for (const keys of localeKeysOf(projected.props)) expect(keys).toEqual(['nl']);
  });

  it.each(examples)('$name projected to en keeps every en value and only those', ({ input }) => {
    const block = stored(input);
    const projected = projectBlock(block, 'en');
    for (const keys of localeKeysOf(projected.props)) expect(keys).toEqual(['en']);
    for (const f of blockLocalized(projected)) expect(Object.keys(f.value)).toEqual(['en']);
    // Projection only reduces maps: non-localised props are the same values.
    expect(projected.id).toBe(block.id);
    expect(projected.type).toBe(block.type);
  });

  it('describes nested fields: hero image and actions, faq answers, quote attribution', () => {
    const paths = (type: BlockType, name: string) => {
      const e = examples.find((x) => x.type === type && x.name === name)!;
      return blockLocalized(stored(e.input)).map((f) => f.path.join('.'));
    };
    expect(paths('hero', 'hero-cover')).toEqual([
      'props.title',
      'props.body',
      'props.image.alt',
      'props.image.caption',
      'props.actions.0.label',
      'props.actions.1.label',
    ]);
    expect(paths('faq', 'faq-list')).toContain('props.entries.1.answer');
    expect(paths('quote', 'quote-blockquote')).toEqual(['props.text', 'props.attribution.role']);
  });
});

describe('readiness of nested and optional fields', () => {
  const hero = examples.find((e) => e.name === 'hero-cover')!.input as {
    props: Record<string, unknown>;
  };
  const without = (path: (string | number)[]) => {
    const copy = structuredClone(hero) as Record<string, unknown>;
    let at = copy as Record<string | number, unknown>;
    for (const k of path) at = at[k] as Record<string | number, unknown>;
    delete at['en'];
    return copy;
  };

  it.each([
    [['props', 'title'], 'blocks.0.props.title'],
    [['props', 'body'], 'blocks.0.props.body'],
    [['props', 'image', 'alt'], 'blocks.0.props.image.alt'],
    [['props', 'image', 'caption'], 'blocks.0.props.image.caption'],
    [['props', 'actions', 1, 'label'], 'blocks.0.props.actions.1.label'],
  ])('a draft may miss en at %j, publishing en may not', (path, issue) => {
    const doc = docOf([without(path)]);
    expect(readinessIssues(doc, 'nl')).toEqual([]);
    expect(readinessIssues(doc, 'en')).toEqual([
      { path: issue, message: 'content.publish.missing-translation' },
    ]);
  });

  it('a decorative image asks for no alt text in any locale', () => {
    const e = examples.find((x) => x.name === 'image-full-decorative')!;
    const doc = docOf([e.input]);
    expect(readinessIssues(doc, 'en')).toEqual([]);
    expect(blockLocalized(doc.blocks[0]!)).toEqual([]);
  });
});

describe('refusals', () => {
  const base = (type: BlockType, name?: string) => {
    const e = examples.find((x) => x.type === type && (!name || x.name === name))!;
    return structuredClone(e.input) as { id: string; type: string; version: number; props: any };
  };
  const refused = (block: unknown) => expect(BlockInput.safeParse(block).success).toBe(false);
  const issue = (block: unknown) => {
    const r = BlockInput.safeParse(block);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('refuses an unknown type, a future version and an unknown prop on every type', () => {
    refused({ type: 'gallery', version: 1, props: {} });
    for (const type of BLOCK_TYPES) {
      refused({ ...base(type), version: 2 });
      refused({ ...base(type), props: { ...base(type).props, className: 'x' } });
    }
  });

  it('refuses an unknown variant, width, align or layout', () => {
    refused({ ...base('hero'), props: { ...base('hero').props, variant: 'fullscreen' } });
    refused({ ...base('cta'), props: { ...base('cta').props, width: 'narrow' } });
    refused({ ...base('cta'), props: { ...base('cta').props, align: 'justify' } });
    refused({ ...base('image'), props: { ...base('image').props, layout: 'float' } });
    // A hero's image is content width only; floats belong to the image block.
    const hero = base('hero', 'hero-cover');
    refused({ ...hero, props: { ...hero.props, image: { ...hero.props.image, layout: 'wide' } } });
    // The #8a types gain no variant.
    refused({ ...base('heading'), props: { ...base('heading').props, variant: 'big' } });
  });

  it('refuses unsafe link targets in actions and quote sources', () => {
    const cta = base('cta');
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,x',
      '//evil.example',
      'https://user:pw@example.org',
      'https://example.org/\u0000',
    ])
      refused({
        ...cta,
        props: { ...cta.props, actions: [{ label: { nl: 'x' }, target: { kind: 'url', url } }] },
      });
    refused({
      ...cta,
      props: {
        ...cta.props,
        actions: [{ label: { nl: 'x' }, target: { kind: 'item', itemId: 'about' } }],
      },
    });
    const quote = base('quote');
    for (const url of ['mailto:a@example.org', '/intern', 'ftp://example.org'])
      refused({ ...quote, props: { ...quote.props, attribution: { name: 'A', url } } });
  });

  it('keeps alt and decorative consistent', () => {
    const img = base('image');
    expect(issue({ ...img, props: { ...img.props, decorative: true } })).toContain(
      'content.image.decorative-alt'
    );
    expect(issue({ ...img, props: { ...img.props, alt: null } })).toContain(
      'content.image.alt-required'
    );
    refused({ ...img, props: { ...img.props, alt: { nl: '' } } });
    expect(issue({ ...img, props: { ...img.props, alt: { nl: '   ' } } })).toContain(
      'content.image.alt-empty'
    );
  });

  it('asks a cover or split hero for its image, and bounds actions and entries', () => {
    const hero = base('hero', 'hero-cover');
    const { image: _image, ...noImage } = hero.props;
    expect(issue({ ...hero, props: noImage })).toContain('content.hero.image-required');
    refused({
      ...hero,
      props: { ...hero.props, actions: [1, 2, 3].map(() => hero.props.actions[0]) },
    });
    const cta = base('cta');
    refused({ ...cta, props: { ...cta.props, actions: [] } });
    const faq = base('faq');
    refused({ ...faq, props: { ...faq.props, entries: [] } });
    refused({ ...faq, props: { ...faq.props, entries: Array(31).fill(faq.props.entries[0]) } });
  });

  it('bounds video ids per provider and accepts no URL or HTML', () => {
    const video = base('video-embed');
    const withId = (provider: string, videoId: string) => ({
      ...video,
      props: { ...video.props, provider, videoId },
    });
    expect(BlockInput.safeParse(withId('youtube', 'dQw4w9WgXcQ')).success).toBe(true);
    expect(BlockInput.safeParse(withId('vimeo', '76979871')).success).toBe(true);
    for (const [p, id] of [
      ['youtube', 'dQw4w9WgXc'],
      ['youtube', 'dQw4w9WgXc"'],
      ['vimeo', 'abc'],
      ['vimeo', '123456789012345678901'],
      ['youtube', 'https://youtu.be/dQw4w9WgXcQ'],
    ])
      refused(withId(p!, id!));
    refused({ ...video, props: { ...video.props, html: '<iframe>' } });
    refused({ ...video, props: { ...video.props, autoplay: true } });
  });

  it('keeps text bounds: labels 100, short text 200, body 5000', () => {
    const cta = base('cta');
    refused({
      ...cta,
      props: {
        ...cta.props,
        actions: [{ ...cta.props.actions[0], label: { nl: 'x'.repeat(101) } }],
      },
    });
    refused({ ...cta, props: { ...cta.props, title: { nl: 'x'.repeat(201) } } });
    refused({ ...cta, props: { ...cta.props, body: { nl: 'x'.repeat(5001) } } });
  });
});

describe('tree invariants with the new types', () => {
  it('counts every type against the 200-block limit and keeps ids unique', () => {
    const img = (i: number) => ({
      ...(examples.find((e) => e.type === 'image')!.input as object),
      id: `i${i}`,
    });
    expect(blockTreeIssues(Array.from({ length: MAX_BLOCKS }, (_, i) => img(i)))).toEqual([]);
    expect(
      blockTreeIssues(Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => img(i)))
    ).toContainEqual({
      path: [],
      message: 'content.blocks.too-many',
    });
    expect(blockTreeIssues([img(1), img(1)])).toContainEqual({
      path: [1, 'id'],
      message: 'content.block-id.duplicate',
    });
  });
});

describe('references', () => {
  const rows = (name: string) => {
    const e = examples.find((x) => x.name === name)!;
    return blockReferenceRows([stored(e.input)]).map((r) => `${r.blockId} ${r.type} ${r.refId}`);
  };

  it('extracts media, forms and item links per block, once per target', () => {
    expect(rows('image-content')).toEqual([`image-0 media ${EXAMPLE_IDS.image}`]);
    expect(rows('hero-cover')).toEqual([
      `hero-1 media ${EXAMPLE_IDS.image}`,
      `hero-1 item ${EXAMPLE_IDS.item}`,
    ]);
    expect(rows('form-default')).toEqual([`form-0 form ${EXAMPLE_IDS.form}`]);
    expect(rows('signup-form')).toEqual([`signup-form-0 form ${EXAMPLE_IDS.form}`]);
    // nl and en both link the same item: one row.
    expect(rows('rich-text')).toEqual([`rich-text-0 item ${EXAMPLE_IDS.item}`]);
    expect(rows('callout-info')).toEqual([`callout-0 item ${EXAMPLE_IDS.item}`]);
    expect(rows('faq-list')).toEqual([`faq-0 item ${EXAMPLE_IDS.item}`]);
    expect(rows('cta-band')).toEqual([`cta-0 item ${EXAMPLE_IDS.item}`]);
    expect(rows('quote-pullquote-wide')).toEqual([]);
    expect(rows('video-youtube')).toEqual([]);
  });
});

describe('stored #8a documents', () => {
  // A revision as #8a stored it: the four original types at version 1, no new props.
  const legacy = {
    type: 'page',
    title: { nl: 'Aanmelden', en: 'Sign up' },
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    blocks: [
      { id: 'h', type: 'heading', version: 1, props: { text: { nl: 'Doe mee', en: 'Join' } } },
      { id: 's', type: 'signup-form', version: 1, props: { formId: EXAMPLE_IDS.form } },
      {
        id: 'r',
        type: 'rich-text',
        version: 1,
        props: {
          content: {
            nl: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hoi' }] }],
            },
            en: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
            },
          },
        },
      },
      { id: 'p', type: 'paywall', version: 1, props: {} },
    ],
    seo: { noindex: false },
    access: { level: 'members', teaser: 'marker' },
  };

  it('parses byte for byte: no new defaults appear on the original types', () => {
    expect(JSON.stringify(ContentDocument.parse(legacy))).toBe(JSON.stringify(legacy));
  });

  it('round-trips through get, revisions, diff and create-from-pattern unchanged', async () => {
    const uow = new MemoryUnitOfWork();
    const invoker = new Invoker(buildRegistry(), uow);
    const p = systemPrincipal('01900000-0000-7000-8000-00000000aaaa', 'test');
    await uow.run(p, (ctx) => ctx.forms.insert(probeForm(EXAMPLE_IDS.form)));
    const { item, revision } = await invoker.run(useCases.createItem, p, {
      slug: 'legacy',
      document: legacy as never,
    });
    const got = await invoker.run(useCases.getItem, p, { itemId: item.id });
    expect(JSON.stringify(got.revision.document)).toBe(JSON.stringify(legacy));
    const again = await invoker.run(useCases.updateItem, p, {
      itemId: item.id,
      baseRevisionId: revision.id,
      document: got.revision.document,
    });
    const { revisions } = await invoker.run(useCases.listRevisions, p, { itemId: item.id });
    expect(revisions).toHaveLength(2);
    const { changes } = await invoker.run(useCases.diffRevisions, p, {
      itemId: item.id,
      fromRevisionId: revision.id,
      toRevisionId: again.revision.id,
    });
    expect(changes).toEqual([]);
    const pattern = await invoker.run(useCases.createPattern, p, {
      name: { nl: 'Oud' },
      intendedType: 'page',
      blocks: legacy.blocks.filter((b) => b.type !== 'paywall') as never,
    });
    const copy = await invoker.run(useCases.createItem, p, {
      slug: 'legacy-copy',
      patternId: pattern.id,
      document: { ...legacy, access: { level: 'public' }, blocks: [] } as never,
    });
    const strip = (blocks: { id: string }[]) => blocks.map(({ id: _id, ...b }) => b);
    expect(strip(copy.revision.document.blocks)).toEqual(
      strip(legacy.blocks.filter((b) => b.type !== 'paywall'))
    );
  });
});

describe('entitlements', () => {
  const TENANT = '01900000-0000-7000-8000-00000000aaaa';
  const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());

  it.each(BLOCK_TYPES)('%s is behind blocks.%s on item and pattern writes', async (type) => {
    const off = systemPrincipal(TENANT, 'test', {
      entitlements: { ...DEFAULT_ENTITLEMENTS, blocks: { [type]: false } },
      status: 'active',
    });
    const block = examples.find((e) => e.type === type)!.input;
    const refused = { code: 'limit_exceeded', issues: [{ message: 'entitlements.feature_off' }] };
    await expect(
      invoker.run(useCases.createItem, off, {
        slug: `off-${type}`,
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          title: { nl: 'Titel', en: 'Title' },
          blocks: [block as never],
          ...(type === 'paywall' ? { access: { level: 'members', teaser: 'marker' } } : {}),
        },
      })
    ).rejects.toMatchObject(refused);
    await expect(
      invoker.run(useCases.createPattern, off, {
        name: { nl: 'Patroon' },
        intendedType: 'page',
        blocks: [block as never],
      })
    ).rejects.toMatchObject(refused);
  });
});
