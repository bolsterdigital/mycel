import { describe, expect, it } from 'vitest';
import { preserveTranslationReview } from './translation-review.js';
import { BLOCK_DEFINITIONS } from './block-types.js';
import { MAX_BLOCKS, assignBlockIds, projectBlock, type Block } from './blocks.js';
import {
  ContentDocument,
  ContentDocumentInput,
  Tags,
  canonicalTag,
  isReservedPageSlug,
  readinessIssues,
} from './model.js';

const heading = (id: string | undefined, text: Record<string, string>) => ({
  ...(id ? { id } : {}),
  type: 'heading' as const,
  version: 1 as const,
  props: { text },
});
const prose = (id: string | undefined, content: Record<string, string>) => ({
  ...(id ? { id } : {}),
  type: 'rich-text' as const,
  version: 1 as const,
  props: {
    content: Object.fromEntries(
      Object.entries(content).map(([l, t]) => [
        l,
        { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] },
      ])
    ),
  },
});
const paywall = (id?: string) => ({
  ...(id ? { id } : {}),
  type: 'paywall' as const,
  version: 1 as const,
  props: {},
});

const page = (over: Record<string, unknown> = {}) => ({
  type: 'page',
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  title: { nl: 'Titel', en: 'Title' },
  blocks: [heading('h1', { nl: 'Kop', en: 'Heading' })],
  ...over,
});
const article = (over: Record<string, unknown> = {}) => ({
  ...page(),
  type: 'article',
  authorIds: ['01900000-0000-7000-8000-00000000a001'],
  ...over,
});

const messages = (value: unknown) =>
  ContentDocument.safeParse(value).error?.issues.map((i) => i.message) ?? [];

describe('block tree invariants (ADR 020 rules 1 and 4)', () => {
  it('requires unique block ids in the stored document, and lets input omit them', () => {
    expect(
      messages(page({ blocks: [heading('a', { nl: 'x' }), heading('a', { nl: 'y' })] }))
    ).toContain('content.block-id.duplicate');
    expect(messages(page({ blocks: [heading(undefined, { nl: 'x' })] })).length).toBeGreaterThan(0);
    expect(
      ContentDocumentInput.safeParse(page({ blocks: [heading(undefined, { nl: 'x' })] })).success
    ).toBe(true);
  });

  it('keeps given ids and assigns new ones only where missing', () => {
    let n = 0;
    const blocks = assignBlockIds(
      [heading('keep', { nl: 'x' }), heading(undefined, { nl: 'y' })] as never,
      () => `new-${++n}`
    );
    expect(blocks.map((b) => b.id)).toEqual(['keep', 'new-1']);
  });

  it(`allows at most ${MAX_BLOCKS} blocks`, () => {
    const blocks = Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => heading(`b${i}`, { nl: 'x' }));
    expect(messages(page({ blocks }))).toContain('content.blocks.too-many');
    expect(messages(page({ blocks: blocks.slice(1) }))).toEqual([]);
  });

  it('refuses two adjacent rich-text blocks, but not rich text around another block', () => {
    expect(
      messages(page({ blocks: [prose('a', { nl: 'x' }), prose('b', { nl: 'y' })] }))
    ).toContain('content.blocks.adjacent-rich-text');
    expect(
      messages(
        page({
          blocks: [prose('a', { nl: 'x' }), heading('h', { nl: 'k' }), prose('b', { nl: 'y' })],
        })
      )
    ).toEqual([]);
  });

  it('refuses a value for a locale the document does not have', () => {
    expect(messages(page({ title: { nl: 'x', de: 'y' } }))).toContain(
      'i18n.locale-not-in-document'
    );
    expect(messages(page({ defaultLocale: 'de' }))).toContain('i18n.default-not-in-locales');
  });

  it('projects a block to one locale and drops the others', () => {
    const block = prose('a', { nl: 'Nederlands', en: 'ENGLISH DRAFT' }) as unknown as Block;
    expect(JSON.stringify(projectBlock(block, 'nl'))).not.toContain('ENGLISH DRAFT');
  });
});

describe('access and teaser (ADR 016 rule 3, ADR 018 rule 6)', () => {
  const restricted = (teaser: unknown, blocks: unknown[] = [heading('h', { nl: 'x' })]) =>
    article({ blocks, access: { level: 'members', teaser } });

  it('marker needs exactly one top-level paywall block', () => {
    expect(messages(restricted('marker'))).toContain('content.access.marker-needs-one-paywall');
    expect(
      messages(restricted('marker', [heading('h', { nl: 'x' }), paywall('p1'), paywall('p2')]))
    ).toContain('content.access.marker-needs-one-paywall');
    expect(messages(restricted('marker', [heading('h', { nl: 'x' }), paywall('p')]))).toEqual([]);
  });

  it('a paywall block without the marker teaser is refused', () => {
    expect(messages(restricted('lead', [paywall('p')]))).toContain(
      'content.access.paywall-without-marker'
    );
  });

  it('an explicit block count is a non-negative integer within the tree', () => {
    expect(messages(restricted({ blocks: 2 }))).toContain('content.access.teaser-too-long');
    expect(messages(restricted({ blocks: -1 })).length).toBeGreaterThan(0);
    expect(messages(restricted({ blocks: 1.5 })).length).toBeGreaterThan(0);
    expect(messages(restricted({ blocks: 1 }))).toEqual([]);
  });

  it('tier access needs tier ids, and only tier access may have them', () => {
    expect(messages(article({ access: { level: 'tier' } }))).toContain(
      'content.access.tier-ids-required'
    );
    expect(
      messages(
        article({ access: { level: 'members', tierIds: ['01900000-0000-7000-8000-00000000c001'] } })
      )
    ).toContain('content.access.tier-ids-unexpected');
  });

  it('defaults to public with the lead as teaser', () => {
    expect(ContentDocument.parse(page()).access).toEqual({ level: 'public', teaser: 'lead' });
  });
});

describe('readiness per locale (ADR 018 rule 9)', () => {
  const doc = (over: Record<string, unknown>) => ContentDocument.parse(article(over));

  it('needs every visible field in the published locale, with no fallback', () => {
    const d = doc({ blocks: [heading('h', { nl: 'Kop' }), prose('p', { nl: 'Tekst' })] });
    expect(readinessIssues(d, 'nl')).toEqual([]);
    expect(readinessIssues(d, 'en').map((i) => i.path)).toEqual([
      'blocks.0.props.text',
      'blocks.1.props.content',
    ]);
    expect(readinessIssues(d, 'de')).toEqual([
      { path: 'locale', message: 'content.publish.locale-not-in-document' },
    ]);
  });

  it('needs an author, a lead in every locale once given, and the lead for a lead teaser', () => {
    expect(readinessIssues(doc({ authorIds: [] }), 'nl')).toContainEqual({
      path: 'authorIds',
      message: 'content.publish.author-required',
    });
    expect(readinessIssues(doc({ lead: { nl: 'Intro' } }), 'en').map((i) => i.path)).toContain(
      'lead'
    );
    expect(readinessIssues(doc({ access: { level: 'members' } }), 'nl')).toContainEqual({
      path: 'lead',
      message: 'content.publish.teaser-lead-required',
    });
  });

  it('fails closed on tier access until tiers can be verified (#19)', () => {
    const d = doc({ access: { level: 'tier', tierIds: ['01900000-0000-7000-8000-00000000c001'] } });
    expect(readinessIssues(d, 'nl')).toContainEqual({
      path: 'access.tierIds',
      message: 'content.publish.tier-unverifiable',
    });
  });

  it('treats SEO overrides as optional: absent is derived, present must not be empty', () => {
    expect(
      readinessIssues(doc({ seo: { title: { nl: 'Zoektitel' } } }), 'en').map((i) => i.path)
    ).not.toContain('seo.title');
    expect(messages(article({ seo: { title: { nl: '' } } })).length).toBeGreaterThan(0);
    expect(messages(article({ seo: { canonical: 'https://user:pw@example.org/' } }))).toContain(
      'content.seo.canonical.invalid'
    );
  });
});

describe('routes and tags (brief #8a § 2)', () => {
  it.each([
    'admin',
    'api',
    'internal',
    'v1',
    'confirm',
    'reader',
    'articles',
    'authors',
    'sections',
    'tags',
    'assets',
    'healthz',
    'nl',
    'en',
    'pt',
    'faq',
  ])('reserves the page slug %s', (slug) => expect(isReservedPageSlug(slug)).toBe(true));

  it.each(['index', 'signup', 'over-ons', 'nl-2026'])('allows the page slug %s', (slug) =>
    expect(isReservedPageSlug(slug)).toBe(false)
  );

  it('canonicalises tags to NFC, trimmed, lowercase, single-spaced, deduplicated in order', () => {
    expect(canonicalTag('  Café   Politiek ')).toBe('café politiek');
    expect(Tags.parse(['Klimaat', 'klimaat ', 'Den Haag', 'co2-uitstoot'])).toEqual([
      'klimaat',
      'den haag',
      'co2-uitstoot',
    ]);
    expect(Tags.safeParse(['#hashtag']).success).toBe(false);
    expect(Tags.safeParse(Array.from({ length: 21 }, (_, i) => `t${i}`)).success).toBe(false);
  });
});

describe('locale-wide translation review', () => {
  it.each([undefined, {}, { en: [] }])(
    'preserves ordinary documents without pending review (%j)',
    (markers) => {
      const previous = ContentDocument.parse(
        page({ ...(markers ? { machineTranslation: markers } : {}) })
      );
      const next = ContentDocument.parse({
        ...previous,
        title: { nl: 'Gewijzigd', en: 'Changed' },
      });
      // Empty client metadata is not a review requirement; no new metadata is invented.
      const saved = preserveTranslationReview(previous, next);
      expect(saved.machineTranslation).toBeUndefined();
      expect({ ...saved, machineTranslation: next.machineTranslation }).toEqual(next);
    }
  );

  it.each(['locales', 'blocks.deleted.props.content'])(
    'blocks reserved and legacy markers immediately, even without that field (%s)',
    (path) => {
      const previous = ContentDocument.parse(page({ machineTranslation: { en: [path] } }));
      expect(readinessIssues(previous, 'en')).toContainEqual({
        path,
        message: 'content.publish.machine-translation-unreviewed',
      });
      const next = preserveTranslationReview(
        previous,
        ContentDocument.parse({ ...previous, machineTranslation: {} })
      );
      expect(next.machineTranslation).toEqual({ en: ['locales'] });
      expect(previous.machineTranslation).toEqual({ en: [path] });
    }
  );

  it.each([
    ['canonical', { seo: { canonical: 'https://example.org/translated' } }],
    ['tags', { tags: ['translated text'] }],
    [
      'list slug',
      { delivery: { email: { listId: 'translated-text', subject: { nl: 'Onderwerp' } } } },
    ],
    [
      'credit',
      {
        blocks: [
          {
            id: 'photo',
            type: 'image',
            version: 1,
            props: {
              ...BLOCK_DEFINITIONS.image.examples[0]!.props,
              credit: { work: { title: 'Translated text', maker: 'Maker' }, photographer: null },
            },
          },
        ],
      },
    ],
    [
      'quote name and URL',
      {
        blocks: [
          {
            id: 'quote',
            type: 'quote',
            version: 1,
            props: {
              text: { en: 'Text' },
              attribution: { name: 'Translated text', url: 'https://example.org/text' },
            },
          },
        ],
      },
    ],
    [
      'action URL',
      {
        blocks: [
          {
            id: 'cta',
            type: 'cta',
            version: 1,
            props: {
              title: { en: 'Text' },
              actions: [
                { label: { en: 'Text' }, target: { kind: 'url', url: '/translated-text' } },
              ],
            },
          },
        ],
      },
    ],
    [
      'video id',
      {
        blocks: [
          {
            id: 'video',
            type: 'video-embed',
            version: 1,
            props: { provider: 'vimeo', videoId: '123456', title: { en: 'Text' } },
          },
        ],
      },
    ],
  ])('refuses nonprojected text in %s while review is pending', (_name, change) => {
    const previous = ContentDocument.parse(article({ machineTranslation: { en: ['locales'] } }));
    const next = ContentDocument.parse({ ...previous, ...change });
    expect(() => preserveTranslationReview(previous, next)).toThrowError(
      expect.objectContaining({ code: 'invalid_input' })
    );
  });

  it('allows known non-text controls while retaining review', () => {
    const previous = ContentDocument.parse(
      page({
        machineTranslation: { en: ['locales'] },
        blocks: [
          {
            id: 'image',
            type: 'image',
            version: 1,
            props: BLOCK_DEFINITIONS.image.examples[0]!.props,
          },
        ],
      })
    );
    const next = ContentDocument.parse({
      ...previous,
      seo: { noindex: true },
      blocks: [{ ...previous.blocks[0]!, props: { ...previous.blocks[0]!.props, layout: 'wide' } }],
    });
    const saved = preserveTranslationReview(previous, next);
    expect(saved.machineTranslation).toEqual({ en: ['locales'] });
    expect(saved.blocks).toEqual(next.blocks);
  });
});
