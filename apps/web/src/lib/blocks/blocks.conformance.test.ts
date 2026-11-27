// Block conformance of the renderer (docs/architecture/testing.md, brief #8c § 5), driven by the
// registry: every example of every type in `BLOCK_DEFINITIONS` is projected to each locale,
// resolved against fixtures for `EXAMPLE_IDS`, and rendered to HTML (`svelte/server`) and
// Markdown. A new type or example is covered by adding it to the registry.
//
// Per example: an HTML snapshot per locale (reviewed, not regenerated: a changed snapshot is
// named in the PR with its reason), heading levels from context, no other locale's text in any
// representation, images with intrinsic size, alt, srcset and sizes, and no style attribute,
// <style>, <script> or `javascript:` anywhere. The negative fixtures prove that a restricted
// image, an unpublished link target and every block behind a teaser boundary never reach either
// representation. The theme tokens' grammar is checked in ../theme/tokens.test.ts.

import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
  BLOCK_DEFINITIONS,
  BLOCK_TYPES,
  Block,
  EXAMPLE_IDS,
  projectBlock,
  CREDIT_KINDS,
  MediaCredit,
  creditKind,
  teaserDocument,
  type BlockField,
  type ContentDocument,
  type CreditKind,
  type MediaView,
  DEFAULT_THEME,
} from '@mycel/core';
import {
  demoArticle,
  demoPage,
  probeForm,
  conditionalProbeForm,
  LOCALE_SENTINEL,
  markEnglish,
} from '@mycel/core/testing';
import { formValues } from '../editor/block-form.js';
import Blocks from './Blocks.svelte';
import BlockText from '../admin/ui/display/BlockText.svelte';
import { overviewFixture } from './overview-fixture.js';
import { textRestOf } from '../server/content/content-blocks.js';
import { headingTag } from './headings.js';
import { renderMarkdown } from './markdown.js';
import { resolveDocument, type ResolveSource } from './resolve.js';
import type { RenderBlock } from './model.js';
import { shownBlockIds } from './shown.js';
import { preloadFonts, withItalicPreload } from '../theme/tokens.js';

/** A fixed challenge, so the snapshots do not change per run. */
const PROOF = {
  algorithm: 'SHA-256' as const,
  challenge: '0'.repeat(64),
  salt: 'salt',
  maxNumber: 100_000,
  signature: 'signature',
};

const LOCALES = ['nl', 'en'] as const;
const RESTRICTED = '01900000-0000-7000-8000-00000000d0ff';
const UNKNOWN_FILE = '01900000-0000-7000-8000-00000000d0fe';
const UNPUBLISHED = '01900000-0000-7000-8000-00000000c0ff';

function asset(id: string, width: number, height: number, focal = { x: 0.5, y: 0.5 }): MediaView {
  const widths = [320, 640, 960].filter((w) => w <= width);
  const variants = widths.flatMap((w) =>
    (['avif', 'webp'] as const).map((format) => ({
      name: `w${w}`,
      format,
      width: w,
      height: Math.round((w * height) / width),
      path: `/media/${id}/w${w}.${format}`,
    }))
  );
  return {
    id,
    kind: 'image',
    contentType: 'image/jpeg',
    filename: 'photo.jpg',
    width,
    height,
    sizeBytes: 1,
    totalBytes: 1,
    checksum: 'x',
    access: 'public',
    // Only the nl caption: the en one must never show in Dutch, and is not filled in English.
    caption: { nl: 'Bijschrift van het beeld' },
    credit: { work: null, photographer: 'Archief' },
    source: null,
    licence: null,
    focal,
    state: 'ready',
    usageCount: 1,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
    variants,
  };
}

/** Resolver fixtures for the example ids, plus one restricted image and one unpublished item. */
const fixtures: ResolveSource = {
  async video(id) {
    return id === EXAMPLE_IDS.video
      ? {
          metadata: {
            title: { en: 'A recording', nl: 'Een opname' },
            maker: 'Mycel',
            licence: { code: 'cc0' },
            watchUrl: 'https://example.com/river',
          },
          duration: 54,
          posterId: EXAMPLE_IDS.image,
          playable: false,
          transcript: [],
          transcriptText: [],
          chapters: [],
        }
      : null;
  },
  async peopleGrid(props, locale) {
    return [
      {
        id: '01900000-0000-7000-8000-00000000a001',
        kind: 'person',
        slug: 'sam',
        name: 'Sam',
        bio: locale === 'nl' ? 'Schrijft over de stad.' : 'Writes about the city.',
        role: locale === 'nl' ? 'Redacteur' : 'Editor',
        organisation: null,
        publicEmail: 'sam@example.org',
        phone: null,
        imageId: props.source === 'group' ? null : EXAMPLE_IDS.portrait,
        links: [{ label: 'Website', url: 'https://example.org', kind: 'website' }],
        pageEnabled: props.source !== 'group',
      },
      // A group may mix kinds: an organisation's name links to its website, never a profile.
      ...(props.source === 'group'
        ? [
            {
              id: '01900000-0000-7000-8000-00000000a003',
              kind: 'organisation' as const,
              slug: 'buurtfonds',
              name: 'Buurtfonds',
              bio: locale === 'nl' ? 'Steunt buurtinitiatieven.' : 'Supports local initiatives.',
              role: null,
              organisation: null,
              publicEmail: null,
              phone: null,
              imageId: EXAMPLE_IDS.portrait,
              links: [
                { label: 'Website', url: 'https://buurtfonds.example', kind: 'website' as const },
              ],
              pageEnabled: false,
            },
          ]
        : []),
    ];
  },
  async form(id) {
    return id === EXAMPLE_IDS.form
      ? { form: probeForm(id), startedToken: 'started-token', proof: PROOF }
      : null;
  },
  async media(id) {
    if (id === EXAMPLE_IDS.image) return asset(id, 1600, 900, { x: 0.3, y: 0.7 });
    if (id === EXAMPLE_IDS.portrait) return asset(id, 800, 1000);
    if (id === EXAMPLE_IDS.document)
      return {
        ...asset(id, 1, 1),
        kind: 'document',
        contentType: 'application/pdf',
        filename: 'jr-2025-final-v3.pdf',
        width: null,
        height: null,
        sizeBytes: 845_000,
        variants: [
          { name: 'file', format: 'pdf', width: null, height: null, path: `/media/${id}/file.pdf` },
        ],
      };
    if (id === EXAMPLE_IDS.audio)
      return {
        ...asset(id, 1, 1),
        kind: 'audio',
        contentType: 'audio/mpeg',
        filename: 'raad-opname-def.mp3',
        width: null,
        height: null,
        sizeBytes: 4_200_000,
        variants: [
          { name: 'file', format: 'mp3', width: null, height: null, path: `/media/${id}/file.mp3` },
        ],
      };
    if (id === RESTRICTED)
      return {
        ...asset(id, 1600, 900),
        access: 'restricted',
        variants: asset(id, 1600, 900).variants.map((v) => ({ ...v, path: '' })),
      };
    return null;
  },
  async itemPath(id) {
    return id === EXAMPLE_IDS.item ? '/jaarverslag' : null;
  },
  // The example campaign is open, with its form, image and a public count; the example form is
  // bound to no campaign. `resolve.test.ts` covers the other phases and every reason.
  async campaignCard(campaignId, locale) {
    if (campaignId !== EXAMPLE_IDS.campaign)
      return { available: false, campaignId, reason: 'unknown' };
    return {
      available: true,
      campaignId,
      kind: 'petition',
      locale,
      landing: {
        id: EXAMPLE_IDS.item,
        type: 'page',
        slug: locale === 'nl' ? 'red-het-park' : 'save-the-park',
        revisionId: '01900000-0000-7000-8000-00000000c1e1',
        title: locale === 'nl' ? 'Red het park' : 'Save the park',
        summary: locale === 'nl' ? 'Teken voor het park.' : 'Sign for the park.',
        imageId: EXAMPLE_IDS.image,
        // The campaign's text with a subheading, so a full card folds it, and one block the card
        // leaves out, so it links to the rest (ADR 038 rule 4).
        body: {
          blocks: [
            {
              id: 'constateren',
              type: 'heading',
              version: 1,
              props: { text: { nl: 'Wij constateren', en: 'We note' } },
            },
            {
              id: 'tekst',
              type: 'rich-text',
              version: 1,
              props: {
                content: {
                  nl: paragraph('Het park is de enige groene plek in de wijk.'),
                  en: paragraph('The park is the only green space in the neighbourhood.'),
                },
              },
            },
          ],
          more: true,
        },
      },
      phase: 'open',
      opensAt: null,
      closesAt: null,
      counter: { participants: 1234, raised: null, target: 5000 },
      formId: EXAMPLE_IDS.form,
    };
  },
  async formCampaign() {
    return null;
  },
  // How a list renders, not which items it holds: `overview-fixture.ts`.
  overview: async (props, locale) => overviewFixture(props, locale),
};

function paragraph(text: string) {
  return {
    type: 'doc' as const,
    content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
  };
}

const examples = BLOCK_TYPES.flatMap((type) =>
  BLOCK_DEFINITIONS[type].examples.map((e) => ({
    type,
    name: e.name,
    block: Block.parse({
      id: e.name,
      type,
      version: BLOCK_DEFINITIONS[type].version,
      props: e.props,
    }),
  }))
);

const SITE_ROOT = 'https://probe.example';

/** Snapshots are formatted with the repository's Prettier config, so `format:check` agrees. */
const prettierConfig = await resolveConfig(fileURLToPath(import.meta.url));
const pretty = (html: string) =>
  format(html || '<!-- empty -->', { ...prettierConfig, parser: 'html' });

async function representations(blocks: Block[], locale: string, title = 'Titel', today?: string) {
  const model = await resolveDocument(
    fixtures,
    { locale, title, blocks: blocks.map((b) => projectBlock(b, locale)) },
    {
      base: '',
      fallbackLocale: 'nl',
      path: locale === 'nl' ? '/overzicht' : '/en/overview',
      ...(today ? { today } : {}),
    }
  );
  const html = render(Blocks, { props: { model } })
    .body.replace(/<!--[^>]*-->/g, '')
    .trim();
  const markdown = renderMarkdown(model, {
    canonicalUrl: `${SITE_ROOT}/pagina`,
    siteRoot: SITE_ROOT,
  });
  return { model, html, markdown };
}

/** A rich-text document with one heading per given relative level. */
const richHeadings = (levels: number[]) => ({
  type: 'doc',
  content: levels.map((level) => ({
    type: 'heading',
    attrs: { level },
    content: [{ type: 'text', text: `Niveau ${level}` }],
  })),
});

const headingLevels = (html: string) =>
  [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));

/** No level skipped going down, and nothing above h2 under the document title. */
function outlineProblems(levels: number[]): string[] {
  const out: string[] = [];
  let previous = 1;
  for (const level of levels) {
    if (level === 1) out.push('h1 outside the document title');
    if (level > previous + 1) out.push(`h${previous} followed by h${level}`);
    previous = level;
  }
  return out;
}

function markupProblems(html: string): string[] {
  const out: string[] = [];
  if (/\sstyle=/i.test(html)) out.push('style attribute');
  if (/<style[\s>]/i.test(html)) out.push('<style>');
  if (/<script[\s>]/i.test(html)) out.push('<script>');
  if (/(href|src|srcset)="\s*javascript:/i.test(html)) out.push('javascript: URL');
  for (const [img] of html.matchAll(/<img\b[^>]*>/g)) {
    for (const attr of ['width', 'height', 'alt', 'srcset', 'sizes'])
      if (!new RegExp(`\\s${attr}="`).test(img)) out.push(`img without ${attr}`);
  }
  return out;
}

// A new block starts from the empty form, which the seeded examples never go through: a form that
// offers fewer rows than the schema asks, or selects another value than the schema's default, shows
// only once an editor uses it (review of #286).
describe('the empty form of every block agrees with its schema', () => {
  const lists = (fields: readonly BlockField[], at: string): [string, number][] =>
    fields.flatMap((f) => {
      const name = `${at}.${f.key}`;
      if (f.kind === 'group') return lists(f.fields, name);
      return f.kind === 'list' ? [[name, f.min]] : [];
    });

  for (const type of BLOCK_TYPES) {
    const { fields, examples: forType, version } = BLOCK_DEFINITIONS[type];

    it(`${type} offers at least the rows each list asks for`, () => {
      const values = formValues(fields, undefined, LOCALES);
      for (const [name, min] of lists(fields, 'p'))
        expect(Number(values[`${name}.rows`]), name).toBeGreaterThanOrEqual(min);
    });

    it(`${type} selects each choice's default`, () => {
      const values = formValues(fields, undefined, LOCALES);
      for (const f of fields) {
        if (f.kind !== 'choice') continue;
        // The default is what the schema makes of the example without this key; a required choice
        // refuses that and has no default to agree with.
        const { [f.key]: _without, ...props } = forType[0]!.props as Record<string, unknown>;
        const parsed = Block.safeParse({ id: 'x', type, version, props });
        if (!parsed.success) continue;
        const stored = (parsed.data.props as Record<string, unknown>)[f.key];
        if (stored !== undefined) expect(values[`p.${f.key}`], f.key).toBe(stored);
      }
    });
  }
});

describe('every example renders to HTML and Markdown', () => {
  for (const { name, type, block } of examples)
    for (const locale of LOCALES)
      it(`${name} (${locale})`, async () => {
        const { html, markdown, model } = await representations([block], locale);
        expect(model.blocks).toHaveLength(1);
        if (type !== 'paywall') expect(html).not.toBe('');
        else expect(html).toBe('');
        // A menu anchor lands on every example but the boundary (`shown.ts`).
        expect(shownBlockIds(model).has(block.id)).toBe(type !== 'paywall');
        // A paywall and a decorative image add nothing to the Markdown; everything else does.
        const silent =
          block.type === 'paywall' || (block.type === 'image' && block.props.decorative);
        expect(markdown.split('\n\n').length > 1).toBe(!silent);
        expect(markupProblems(html)).toEqual([]);
        expect(outlineProblems(headingLevels(html))).toEqual([]);
        expect(markdown).not.toMatch(/<[a-z][a-z0-9-]*[\s>/]/i);
        await expect(await pretty(html)).toMatchFileSnapshot(
          `__snapshots__/${name}.${locale}.html`
        );
      });
});

describe('heading levels come from context', () => {
  it('gives every titled top-level block an h2 and FAQ questions an h3', async () => {
    for (const { block } of examples) {
      const { html } = await representations([block], 'nl');
      const levels = headingLevels(html);
      // The blocks whose title is a heading (a video's title is its link text).
      const titled = ['hero', 'cta', 'callout', 'faq'].includes(block.type);
      if (block.type === 'heading' || (titled && 'title' in block.props && block.props.title))
        expect(levels[0], block.id).toBe(2);
      // Questions sit one below the FAQ's title, or straight under the document title without one.
      if (block.type === 'faq')
        expect(levels.filter((l) => l === (block.props.title ? 3 : 2))).toHaveLength(
          block.props.entries.length
        );
    }
  });

  it('maps rich-text headings 1 to 3 to h2 to h4, and deeper under a question', async () => {
    const doc = richHeadings([1, 2, 3]);
    const rich = Block.parse({
      id: 'r',
      type: 'rich-text',
      version: 1,
      props: { content: { nl: doc } },
    });
    expect(headingLevels((await representations([rich], 'nl')).html)).toEqual([2, 3, 4]);
    const faq = Block.parse({
      id: 'f',
      type: 'faq',
      version: 2,
      props: {
        title: { nl: 'Vragen' },
        entries: [{ question: { nl: 'Waarom?' }, answer: { nl: doc } }],
      },
    });
    const { html, markdown } = await representations([faq], 'nl');
    expect(headingLevels(html)).toEqual([2, 3, 4, 5, 6]);
    expect(markdown).toContain('###### Niveau 3');
  });

  // A container with its own title (a campaign card's body, ADR 038 rule 3) renders blocks one
  // level deeper; every block reads that depth, none keeps a fixed level.
  it('moves every heading of every block one level down at depth 2', async () => {
    const atDepth = (model: Awaited<ReturnType<typeof representations>>['model'], depth: number) =>
      headingLevels(render(Blocks, { props: { model, depth } }).body);
    for (const { name, block } of examples) {
      const { model } = await representations([block], 'nl');
      const flat = atDepth(model, 1);
      expect(atDepth(model, 2), name).toEqual(flat.map((l) => l + 1));
    }
    const rich = Block.parse({
      id: 'r',
      type: 'rich-text',
      version: 1,
      props: { content: { nl: richHeadings([1]) } },
    });
    const { model } = await representations([rich], 'nl');
    expect(atDepth(model, 2)).toEqual([3]);
  });

  it('refuses a block that would need a level above h6 at a deeper depth', async () => {
    const faq = Block.parse({
      id: 'f',
      type: 'faq',
      version: 2,
      props: {
        title: { nl: 'Vragen' },
        entries: [{ question: { nl: 'Waarom?' }, answer: { nl: richHeadings([3]) } }],
      },
    });
    const { model } = await representations([faq], 'nl');
    expect(headingLevels(render(Blocks, { props: { model, depth: 1 } }).body)).toEqual([2, 3, 6]);
    expect(() => render(Blocks, { props: { model, depth: 2 } }).body).toThrow(RangeError);
  });

  it('refuses a level above h6 instead of clamping it', () => {
    expect(headingTag(6)).toBe('h6');
    expect(() => headingTag(7)).toThrow(RangeError);
    expect(() => headingTag(0)).toThrow(RangeError);
  });
});

// The kind of image decides the icon and the word of its credit, in every representation.
// A credit without a kind is a photo, so content from before the kind still reads "Foto".
describe('the kind of an image credit', () => {
  const ICON: Record<CreditKind, string> = {
    photo: 'M14.5 4h-5L7 7H4',
    illustration: 'm2.3 2.3 7.286 7.286',
    other: 'm21 15-3.086-3.086',
  };
  const WORD: Record<string, Record<CreditKind, string>> = {
    nl: { photo: 'Foto: ', illustration: 'Illustratie: ', other: 'Beeld: ' },
    en: { photo: 'Photo: ', illustration: 'Illustration: ', other: 'Image: ' },
  };
  const image = examples.find((e) => e.name === 'image-wide-caption-credit')!.block;
  const withCredit = (credit: MediaCredit) =>
    Block.parse({ ...image, props: { ...image.props, credit } });

  for (const locale of ['nl', 'en'] as const)
    for (const kind of [...CREDIT_KINDS, undefined]) {
      const shown = kind ?? 'photo';
      it(`marks ${kind ?? 'a credit without a kind'} with its own icon and word in ${locale}`, async () => {
        const credit: MediaCredit = {
          work: null,
          photographer: 'Lotte Kramer',
          ...(kind && { kind }),
        };
        const { html, markdown } = await representations([withCredit(credit)], locale);
        const by = /<span class="credit-by">[\s\S]*?Lotte Kramer<\/span>/.exec(html)?.[0] ?? '';
        expect(by, html).toContain(ICON[shown]);
        for (const other of CREDIT_KINDS.filter((k) => k !== shown))
          expect(by).not.toContain(ICON[other]);
        // The icon is decoration; the word is what a screen reader hears.
        expect(by).toMatch(/<svg[^>]*aria-hidden="true"/);
        expect(by).toContain(`<span class="credit-word">${WORD[locale]![shown]}</span>`);
        expect(markdown).toContain(`${WORD[locale]![shown]}Lotte Kramer`);
      });
    }

  it('stores a credit without a kind as it was and accepts only the closed list', () => {
    expect(MediaCredit.parse({ work: null, photographer: 'A' })).toEqual({
      work: null,
      photographer: 'A',
    });
    expect(creditKind({})).toBe('photo');
    expect(MediaCredit.safeParse({ work: null, photographer: 'A', kind: 'video' }).success).toBe(
      false
    );
  });
});

describe('nothing leaks into any representation', () => {
  it('carries no text of the other locale', async () => {
    for (const { name, block } of examples) {
      const marked = Block.parse(markEnglish(block));
      const { html, markdown } = await representations([marked], 'nl');
      expect(html, name).not.toContain(LOCALE_SENTINEL);
      expect(markdown, name).not.toContain(LOCALE_SENTINEL);
    }
  });

  it('renders nothing of any block behind the teaser boundary (ADR 018 rule 7)', async () => {
    // Every example in turn is the body of a restricted article. What a visitor's renderers get
    // is the core's teaser document, so the HTML, the Markdown and the render model are those of
    // the opening block alone, for every block type and whatever the example refers to.
    const opening = Block.parse({
      id: 'opening',
      type: 'heading',
      version: 1,
      props: { text: { nl: 'Voor iedereen', en: 'For everyone' } },
    });
    const boundary = Block.parse({ id: 'boundary', type: 'paywall', version: 1, props: {} });
    const alone = await representations([opening], 'nl');
    for (const { name, type, block } of examples) {
      if (type === 'paywall') continue;
      const cut = teaserDocument({
        type: 'article',
        access: { level: 'members', teaser: 'marker' },
        blocks: [opening, boundary, block],
        corrections: [],
      } as unknown as ContentDocument);
      const shown = await representations(cut.blocks, 'nl');
      expect(shown.html, name).toBe(alone.html);
      expect(shown.markdown, name).toBe(alone.markdown);
      expect(JSON.stringify(shown.model), name).toBe(JSON.stringify(alone.model));
    }
    // With the gate, the Markdown ends in the notice and the absolute sign-in address.
    const gated = renderMarkdown(alone.model, {
      canonicalUrl: `${SITE_ROOT}/pagina`,
      siteRoot: SITE_ROOT,
      gate: {
        title: 'Log in [nu]',
        body: 'De rest is voor lezers.',
        action: { label: 'Inloggen', url: `${SITE_ROOT}/reader?return=%2Fpagina` },
      },
    });
    expect(
      gated.endsWith(
        `## Log in \\[nu\\]\n\nDe rest is voor lezers.\n\n[Inloggen](<${SITE_ROOT}/reader?return=%2Fpagina>)\n`
      )
    ).toBe(true);
  });

  it('renders nothing of a restricted image: no figure, src, path or alt', async () => {
    const image = examples.find((e) => e.name === 'image-wide-caption-credit')!.block;
    const hero = examples.find((e) => e.name === 'hero-cover')!.block;
    const swap = (b: Block) =>
      Block.parse(JSON.parse(JSON.stringify(b).replaceAll(EXAMPLE_IDS.image, RESTRICTED)));
    for (const block of [swap(image), swap(hero)]) {
      const { html, markdown, model } = await representations([block], 'nl');
      for (const out of [html, markdown, JSON.stringify(model)]) {
        expect(out).not.toContain(RESTRICTED);
        expect(out).not.toContain('/media/');
        expect(out).not.toContain('Demonstranten');
      }
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<figure');
    }
    // A hero without a renderable image falls back to minimal: its text never sits on nothing.
    const { html } = await representations([swap(hero)], 'nl');
    expect(html).toContain('hero-minimal');
    const video = examples.find((e) => e.name === 'video-bunny-stream')!.block;
    const fallback = await representations([swap(video)], 'nl');
    expect(fallback.html).toContain('class="video-link"');
    expect(fallback.html).not.toContain('<img');
    expect(JSON.stringify(fallback.model)).not.toContain(RESTRICTED);
  });

  it('leaves out a restricted or missing file, and shows nothing with no file left', async () => {
    const block = examples.find((e) => e.name === 'file-download-titled')!.block;
    const props = block.props as { files: { fileId: string; name: object }[] };
    const withIds = (...ids: string[]) =>
      Block.parse({
        ...block,
        props: { ...props, files: ids.map((fileId, i) => ({ ...props.files[i], fileId })) },
      });
    const one = await representations([withIds(EXAMPLE_IDS.document, RESTRICTED)], 'nl');
    for (const out of [one.html, one.markdown, JSON.stringify(one.model)]) {
      expect(out).toContain('Jaarverslag 2025');
      expect(out).not.toContain('Brief aan de gemeente');
      expect(out).not.toContain(RESTRICTED);
    }
    const none = await representations([withIds(RESTRICTED, UNKNOWN_FILE)], 'nl');
    for (const out of [none.html, none.markdown]) {
      expect(out).not.toContain('Stukken bij deze zaak');
      expect(out).not.toContain('/media/');
    }
    expect(none.html).not.toContain('file-download');
  });

  it('leaves out a restricted or missing image of a gallery, and shows nothing with none left', async () => {
    const block = examples.find((e) => e.name === 'gallery-row-content')!.block;
    const props = block.props as { images: { mediaId: string }[] };
    const withIds = (...ids: string[]) =>
      Block.parse({
        ...block,
        props: { ...props, images: ids.map((mediaId, i) => ({ ...props.images[i], mediaId })) },
      });
    const one = await representations([withIds(EXAMPLE_IDS.image, RESTRICTED)], 'nl');
    for (const out of [one.html, one.markdown, JSON.stringify(one.model)]) {
      expect(out).toContain('Op het plein.');
      expect(out).not.toContain(RESTRICTED);
    }
    const none = await representations([withIds(RESTRICTED, UNKNOWN_FILE)], 'nl');
    for (const out of [none.html, none.markdown]) expect(out).not.toContain('/media/');
    expect(none.html).not.toContain('gallery');
  });

  it('a gallery row is a named region a keyboard can scroll; a grid needs neither', async () => {
    const html = async (name: string) =>
      (await representations([examples.find((e) => e.name === name)!.block], 'en')).html;
    expect(await html('gallery-row-content')).toMatch(
      /<ul class="gallery-list" tabindex="0" aria-label="Row of photos"/
    );
    expect(await html('gallery-grid')).not.toContain('tabindex');
  });

  it('a sound file plays, downloads and has its transcript, without its stored filename', async () => {
    const block = examples.find((e) => e.name === 'audio-transcript')!.block;
    const { html, markdown } = await representations([block], 'en');
    expect(html).toMatch(/<audio[^>]*\bcontrols\b/);
    expect(html).toContain(`src="/media/${EXAMPLE_IDS.audio}/file.mp3"`);
    expect(html).toContain('aria-label="The talk with the council"');
    expect(html).toMatch(/<details[^>]*>\s*<summary>Transcript<\/summary>/);
    expect(markdown).toContain('Download the sound');
    expect(markdown).toContain('(MP3, ');
    expect(markdown).toContain('Good morning.\nWe start with the petition.');
    for (const out of [html, markdown]) expect(out).not.toContain('raad-opname-def');
  });

  it('a sound file a visitor may not fetch leaves nothing behind in any representation', async () => {
    const block = examples.find((e) => e.name === 'audio-transcript')!.block;
    const hidden = Block.parse({
      ...block,
      props: { ...(block.props as object), fileId: RESTRICTED },
    });
    const { html, markdown, model } = await representations([hidden], 'en');
    for (const out of [html, markdown, JSON.stringify(model)]) {
      expect(out).not.toContain(RESTRICTED);
      expect(out).not.toContain('<audio');
    }
    for (const out of [html, markdown]) {
      expect(out).not.toContain('The talk with the council');
      expect(out).not.toContain('Good morning');
    }
  });

  it('a timeline sorts by date in every representation, and keeps the editor order on one date', async () => {
    const block = examples.find((e) => e.name === 'timeline-oldest-titled')!.block;
    const titles = (out: string) =>
      ['Petition handed over', 'Debate in the council', 'Decision published'].map((t) =>
        out.indexOf(t)
      );
    const { html, markdown } = await representations([block], 'en');
    for (const out of [html, markdown]) {
      const [first, second, third] = titles(out);
      expect(first).toBeGreaterThan(-1);
      expect(first).toBeLessThan(second!);
      expect(second).toBeLessThan(third!);
    }
    expect(html).toContain('<time datetime="2026-03-02">March 2, 2026</time>');
    expect(markdown).toContain('*March 2, 2026*');
    expect((await representations([block], 'nl')).html).toContain('2 maart 2026');

    const newest = await representations(
      [Block.parse({ ...block, props: { ...(block.props as object), order: 'newest' } })],
      'en'
    );
    const [petition, debate, decision] = titles(newest.html);
    expect(debate).toBeLessThan(decision!);
    expect(decision).toBeLessThan(petition!);
  });

  it('a timeline splits at today on the site clock: reached filled, to come open, "Now" between (MY-278)', async () => {
    const block = examples.find((e) => e.name === 'timeline-oldest-titled')!.block;
    const newest = Block.parse({
      ...block,
      props: { ...(block.props as object), order: 'newest' },
    });
    const items = (html: string) =>
      [...html.matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/g)].map((m) => ({
        future: /timeline-future/.test(m[1]!),
        now: /class="timeline-now" aria-hidden="true">Now</.test(m[2]!),
        title: /<h3[^>]*>([^<]*)<\/h3>/.exec(m[2]!)![1],
      }));
    // Oldest first: the petition is behind us, the debate and the decision still to come.
    const { model, html } = await representations([block], 'en', 'Titel', '2026-04-01');
    expect(items(html)).toEqual([
      { future: false, now: false, title: 'Petition handed over' },
      { future: true, now: true, title: 'Debate in the council' },
      { future: true, now: false, title: 'Decision published' },
    ]);
    const shown = model.blocks[0] as Extract<RenderBlock, { type: 'timeline' }>;
    expect(shown.events.map((e) => e.when)).toEqual(['past', 'future', 'future']);
    // Newest first: the line sits above the first reached event.
    expect(items((await representations([newest], 'en', 'Titel', '2026-04-01')).html)).toEqual([
      { future: true, now: false, title: 'Debate in the council' },
      { future: true, now: false, title: 'Decision published' },
      { future: false, now: true, title: 'Petition handed over' },
    ]);
    // An event on today's date counts as reached; all on one side, no line.
    const reached = items((await representations([block], 'en', 'Titel', '2026-05-19')).html);
    expect(reached.every((e) => !e.future && !e.now)).toBe(true);
    const ahead = items((await representations([block], 'en', 'Titel', '2026-01-01')).html);
    expect(ahead.every((e) => e.future && !e.now)).toBe(true);
    // The line is decoration: the list still holds three events, and the words come from the catalog.
    expect((await representations([block], 'nl', 'Titel', '2026-04-01')).html).toContain(
      '<span class="timeline-now" aria-hidden="true">Nu</span>'
    );
  });

  it('an event title sits one level under the title of its timeline, or at its level without one', async () => {
    const html = async (name: string) =>
      (await representations([examples.find((e) => e.name === name)!.block], 'en')).html;
    expect(await html('timeline-oldest-titled')).toMatch(/<h2[^>]*>How it went<\/h2>/);
    expect(await html('timeline-oldest-titled')).toMatch(/<h3[^>]*>Petition handed over<\/h3>/);
    expect(await html('timeline-newest')).toMatch(/<h2[^>]*>Petition handed over<\/h2>/);
  });

  it('a file link names its kind and size, in HTML and Markdown, not the stored filename', async () => {
    const block = examples.find((e) => e.name === 'file-download-one')!.block;
    const { html, markdown } = await representations([block], 'en');
    expect(html).toContain('Annual report 2025');
    expect(html).toMatch(/PDF, 825[.,]2 kB/);
    expect(markdown).toMatch(/\[Annual report 2025\]\(<.*file\.pdf>\) \(PDF, 825[.,]2 kB\)/);
    expect(html + markdown).not.toContain('jr-2025-final');
  });

  it('drops an action and a text link whose item is not published', async () => {
    const swap = (b: Block) =>
      Block.parse(JSON.parse(JSON.stringify(b).replaceAll(EXAMPLE_IDS.item, UNPUBLISHED)));
    const cta = swap(examples.find((e) => e.name === 'cta-card-two-actions')!.block);
    const rich = swap(examples.find((e) => e.name === 'rich-text')!.block);
    const { html, markdown } = await representations([cta, rich], 'nl');
    expect(html).not.toContain('Teken de petitie');
    expect(html).toContain('Schrijf je vandaag nog in');
    expect(html).toContain('het jaarverslag');
    expect(html).not.toMatch(/<a [^>]*>het jaarverslag/);
    for (const out of [html, markdown]) expect(out).not.toContain('/jaarverslag');
  });

  it('escapes every text and attribute', async () => {
    const block = Block.parse({
      id: 'x',
      type: 'quote',
      version: 1,
      props: {
        text: { nl: '<script>alert(1)</script> & "quotes"' },
        attribution: { name: '<img src=x onerror=alert(1)>' },
      },
    });
    const { html, markdown } = await representations([block], 'nl');
    expect(markupProblems(html)).toEqual([]);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(markdown).not.toMatch(/(^|[^\\])<script/);
  });
});

describe('rich text', () => {
  it('renders marks, lists, safe links, numbered footnotes and passages in another language', async () => {
    const block = Block.parse({
      id: 'r',
      type: 'rich-text',
      version: 1,
      props: {
        content: {
          nl: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'Vet', marks: [{ type: 'bold' }] },
                  { type: 'text', text: ' en ' },
                  {
                    type: 'text',
                    text: 'een bron',
                    marks: [
                      { type: 'link', attrs: { href: 'https://example.org/a?b=1&c=2' } },
                      { type: 'footnote_reference', attrs: { text: 'Gezien op 1 mei.' } },
                    ],
                  },
                  { type: 'hard_break' },
                  { type: 'text', text: 'code', marks: [{ type: 'code' }] },
                  { type: 'text', text: ' als ' },
                  {
                    type: 'text',
                    text: 'raison d’être',
                    marks: [{ type: 'lang', attrs: { lang: 'fr' } }],
                  },
                  { type: 'text', text: ' en ' },
                  {
                    type: 'text',
                    text: 'مرحبا',
                    marks: [{ type: 'italic' }, { type: 'lang', attrs: { lang: 'ar' } }],
                  },
                ],
              },
              {
                type: 'ordered_list',
                attrs: { start: 3 },
                content: [
                  {
                    type: 'list_item',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Drie' }] }],
                  },
                ],
              },
            ],
          },
        },
      },
    });
    const { html, markdown } = await representations([block], 'nl');
    expect(html).toContain('<strong>Vet</strong>');
    expect(html).toContain(
      '<a href="https://example.org/a?b=1&amp;c=2">een bron</a><sup><a href="#fn-r-1" id="fnref-r-1">1</a></sup>'
    );
    expect(html).toContain('<li id="fn-r-1">Gezien op 1 mei.');
    expect(html).toContain('<ol start="3">');
    expect(html).toContain('<code>code</code>');
    // A passage in another language carries its own language and direction, outside its marks.
    expect(html).toContain('<span lang="fr" dir="ltr">raison d’être</span>');
    expect(html).toContain('<span lang="ar" dir="rtl"><em>مرحبا</em></span>');
    expect(markdown).toContain('als raison d’être en *مرحبا*');
    expect(markdown).toContain('[een bron](<https://example.org/a?b=1&c=2>)[^1]');
    expect(markdown).toContain('[^1]: Gezien op 1 mei.');
    expect(markdown).toContain('3. Drie');
  });
});

// The seeded demo page and article: a whole document of interleaved blocks, where
// the examples above each render one block alone. Their images and links point at the example
// ids, so the same fixtures resolve them.
describe('the demo documents render whole', () => {
  const media = {
    market: EXAMPLE_IDS.image,
    bakery: EXAMPLE_IDS.image,
    measuring: EXAMPLE_IDS.portrait,
    signatures: EXAMPLE_IDS.image,
    report: EXAMPLE_IDS.document,
    sound: EXAMPLE_IDS.audio,
  };
  const demos = [
    demoPage({ formId: EXAMPLE_IDS.form, media }),
    demoArticle({ formId: EXAMPLE_IDS.form, media, pageId: EXAMPLE_IDS.item }),
  ].map(({ slug, document }) => ({
    slug,
    blocks: document.blocks.map((b, i) => Block.parse({ ...b, id: `${slug}-${i}` })),
  }));

  for (const { slug, blocks } of demos)
    for (const locale of LOCALES)
      it(`${slug} (${locale})`, async () => {
        const { html, markdown, model } = await representations(blocks, locale);
        // A heading split off above a float (float-order.ts) is one extra part, of the same block.
        expect(model.blocks.filter((b) => !('sourceId' in b))).toHaveLength(blocks.length);
        expect(markupProblems(html)).toEqual([]);
        expect(outlineProblems(headingLevels(html))).toEqual([]);
        expect(markdown).not.toMatch(/<[a-z][a-z0-9-]*[\s>/]/i);
        const marked = blocks.map((b) =>
          Block.parse({
            ...(markEnglish(b) as object),
            name: { nl: 'EDITORIAL-NAME-SENTINEL', en: 'INTERNAL' },
          })
        );
        const leak = await representations(marked, 'nl');
        expect(leak.html + leak.markdown).not.toContain(LOCALE_SENTINEL);
        expect(JSON.stringify(leak)).not.toContain('EDITORIAL-NAME-SENTINEL');
      });

  // The public layout's head, as Svelte renders it, around a document body.
  const page = (body: string) =>
    `<head><link rel="preload" href="${preloadFonts(DEFAULT_THEME)[0]}" as="font" type="font/woff2" crossorigin="anonymous"/></head><body>${body}</body>`;
  const italicLinks = (html: string) =>
    html.match(/<link rel="preload" href="\/fonts\/inter\/inter-latin-italic\.woff2"[^>]*>/g) ?? [];

  it('a page with italic text preloads the italic face once, at low priority', async () => {
    const [page1, article] = await Promise.all(
      demos.map(({ blocks }) => representations(blocks, 'nl'))
    );
    const withItalic = withItalicPreload(page(article!.html));
    expect(italicLinks(withItalic)).toHaveLength(1);
    expect(italicLinks(withItalic)[0]).toContain('fetchpriority="low"');
    expect(withItalic.indexOf('inter-latin-italic')).toBeLessThan(withItalic.indexOf('<body'));
    expect(withItalicPreload(page(page1!.html))).toBe(page(page1!.html));
    // No theme preload (admin, error pages): nothing to add, whatever the body holds.
    expect(withItalicPreload(`<head></head><body><em>x</em></body>`)).toBe(
      `<head></head><body><em>x</em></body>`
    );
    // Italic only in the head (a comment, a script string) does not count.
    expect(withItalicPreload(page('<p>x</p>').replace('<head>', '<head><cite>'))).not.toContain(
      'inter-latin-italic'
    );
  });
});

describe('ordinary form field corpus', () => {
  for (const locale of ['nl', 'en']) {
    it(`renders every typed field natively in ${locale}, with conditional server validation`, async () => {
      const form = conditionalProbeForm(EXAMPLE_IDS.form);
      const source: ResolveSource = {
        ...fixtures,
        form: async () => ({
          form,
          version: 'fixed-version',
          startedToken: 'started-token',
          proof: PROOF,
        }),
      };
      const model = await resolveDocument(
        source,
        {
          locale,
          title: 'Form',
          blocks: [
            {
              type: 'form',
              version: 1,
              id: 'ordinary-form',
              props: { formId: EXAMPLE_IDS.form, variant: 'default', width: 'content' },
            },
          ],
        },
        { base: '', fallbackLocale: 'nl' }
      );
      const html = render(Blocks, { props: { model } }).body;
      for (const field of form.fields) expect(html, field.type).toContain(`name="${field.name}"`);
      expect(html).toContain('name="_formVersion" value="fixed-version"');
      expect(html).toMatch(/<textarea[^>]*name="message"/);
      expect(html.match(/<textarea[^>]+>/)?.[0]).not.toContain('required');
      expect(html).toMatch(/<select[^>]*name="interests"[^>]*multiple/);
      expect(html).toContain('value="public-corpus"');
      expect(html).toContain(locale === 'nl' ? 'Sommige velden hangen' : 'Some fields depend');
      const rest = textRestOf(
        Block.parse({ id: 'form-rest', type: 'form', version: 1, props: { formId: form.id } }),
        locale,
        'b.b.',
        new Map([[form.id, form]])
      );
      if (!rest) throw new Error('form rest fixture must resolve');
      const resting = render(BlockText, {
        props: { view: rest, kindLabel: 'Form', noteLabel: '' },
      }).body;
      expect(resting.match(/class="ui-block-text-check"/g)).toHaveLength(2);
      expect(resting).not.toContain(locale === 'nl' ? 'Bron' : 'Source');
    });
  }
});
