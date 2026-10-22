// Block conformance of the renderer (docs/architecture/testing.md, brief #8c § 5), driven by the
// registry: every example of every type in `BLOCK_DEFINITIONS` is projected to each locale,
// resolved against fixtures for `EXAMPLE_IDS`, and rendered to HTML (`svelte/server`) and
// Markdown. A new type or example is covered by adding it to the registry.
//
// Per example: an HTML snapshot per locale (reviewed, not regenerated: a changed snapshot is
// named in the PR with its reason), heading levels from context, no other locale's text in any
// representation, images with intrinsic size, alt, srcset and sizes, and no style attribute,
// <style>, <script> or `javascript:` anywhere. The negative fixtures prove that a restricted
// image and an unpublished link target never reach either representation. The theme tokens are
// checked here too: complete, finite and inside their grammar for the presets and for random
// valid themes.

import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { format, resolveConfig } from 'prettier';
import {
  BLOCK_DEFINITIONS,
  BLOCK_TYPES,
  Block,
  DEFAULT_THEME,
  EXAMPLE_IDS,
  THEME_PRESETS,
  THEME_RANGES,
  THEME_ROLES,
  Theme,
  projectBlock,
  type MediaView,
  type ResolvedTheme,
} from '@mycel/core';
import { probeForm } from '@mycel/core/testing';
import Blocks from './Blocks.svelte';
import { headingTag } from './headings.js';
import { renderMarkdown } from './markdown.js';
import type { RenderModel } from './model.js';
import { resolveDocument, type ResolveSource } from './resolve.js';
import { STEPS, themeCss } from '../theme/tokens.js';

const LOCALES = ['nl', 'en'] as const;
const RESTRICTED = '01900000-0000-7000-8000-00000000d0ff';
const UNPUBLISHED = '01900000-0000-7000-8000-00000000c0ff';
const SENTINEL = 'LEAK-SENTINEL';

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
  async form(id) {
    return id === EXAMPLE_IDS.form ? { form: probeForm(id), startedToken: 'started-token' } : null;
  },
  async media(id) {
    if (id === EXAMPLE_IDS.image) return asset(id, 1600, 900, { x: 0.3, y: 0.7 });
    if (id === EXAMPLE_IDS.portrait) return asset(id, 800, 1000);
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
};

const examples = BLOCK_TYPES.flatMap((type) =>
  BLOCK_DEFINITIONS[type].examples.map((e) => ({
    type,
    name: e.name,
    block: Block.parse({ id: e.name, type, version: 1, props: e.props }),
  }))
);

const SITE_ROOT = 'https://probe.example';

/** Snapshots are formatted with the repository's Prettier config, so `format:check` agrees. */
const prettierConfig = await resolveConfig(new URL(import.meta.url).pathname);
const pretty = (html: string) =>
  format(html || '<!-- empty -->', { ...prettierConfig, parser: 'html' });

async function representations(blocks: Block[], locale: string, title = 'Titel') {
  const model = await resolveDocument(
    fixtures,
    { locale, title, blocks: blocks.map((b) => projectBlock(b, locale)) },
    { base: '', fallbackLocale: 'nl' }
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

/** Every visible string under an `en` key replaced by a sentinel (core's conformance approach). */
function sentinel(value: unknown, inEn = false, key = ''): unknown {
  if (typeof value === 'string') return inEn && (key === 'en' || key === 'text') ? SENTINEL : value;
  if (Array.isArray(value)) return value.map((v) => sentinel(v, inEn, ''));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sentinel(v, inEn || k === 'en', k)])
    );
  return value;
}

describe('every example renders to HTML and Markdown', () => {
  for (const { name, type, block } of examples)
    for (const locale of LOCALES)
      it(`${name} (${locale})`, async () => {
        const { html, markdown, model } = await representations([block], locale);
        expect(model.blocks).toHaveLength(1);
        if (type !== 'paywall') expect(html).not.toBe('');
        else expect(html).toBe('');
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
    const doc = {
      type: 'doc',
      content: [1, 2, 3].map((level) => ({
        type: 'heading',
        attrs: { level },
        content: [{ type: 'text', text: `Niveau ${level}` }],
      })),
    };
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
      version: 1,
      props: {
        title: { nl: 'Vragen' },
        entries: [{ question: { nl: 'Waarom?' }, answer: { nl: doc } }],
      },
    });
    const { html, markdown } = await representations([faq], 'nl');
    expect(headingLevels(html)).toEqual([2, 3, 4, 5, 6]);
    expect(markdown).toContain('###### Niveau 3');
  });

  it('refuses a level above h6 instead of clamping it', () => {
    expect(headingTag(6)).toBe('h6');
    expect(() => headingTag(7)).toThrow(RangeError);
    expect(() => headingTag(0)).toThrow(RangeError);
  });
});

describe('nothing leaks into any representation', () => {
  it('carries no text of the other locale', async () => {
    for (const { name, block } of examples) {
      const marked = Block.parse(sentinel(block));
      const { html, markdown } = await representations([marked], 'nl');
      expect(html, name).not.toContain(SENTINEL);
      expect(markdown, name).not.toContain(SENTINEL);
    }
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
  it('renders marks, lists, safe links and numbered footnotes', async () => {
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
    expect(markdown).toContain('[een bron](<https://example.org/a?b=1&c=2>)[^1]');
    expect(markdown).toContain('[^1]: Gezien op 1 mei.');
    expect(markdown).toContain('3. Drie');
  });
});

describe('theme tokens', () => {
  const PROPERTIES = [
    ...THEME_ROLES.flatMap((r) => [`--color-${r}-fg`, `--color-${r}-bg`]),
    '--color-link',
    '--color-focus',
    '--font-body',
    '--font-heading',
    '--heading-weight',
    ...STEPS.map((n) => (n < 0 ? `--step--${-n}` : `--step-${n}`)),
    '--measure',
    '--radius',
    '--density',
  ];
  // The grammar of the output: declarations of our own properties with hex colours, plain
  // numbers with a unit, our font names and the @font-face rules of our own files.
  const declaration =
    /^--[a-z0-9-]+: (#[0-9a-f]{6}|-?\d+(\.\d+)?(rem|ch)?|Inter, system-ui, -apple-system, 'Segoe UI', sans-serif|'Source Serif 4', Georgia, 'Times New Roman', serif);$/i;

  function problems(theme: ResolvedTheme): string[] {
    const css = themeCss(theme);
    const out: string[] = [];
    if (/NaN|Infinity|undefined|e[+-]\d/.test(css)) out.push('non-finite or exponent number');
    for (const p of PROPERTIES) if (!css.includes(`${p}:`)) out.push(`missing ${p}`);
    for (const line of css.split('\n').map((l) => l.trim())) {
      if (!line || line === '}' || line === ':root {' || line === 'color-scheme: light dark;')
        continue;
      if (line === '@media (prefers-color-scheme: dark) {') continue;
      if (line.startsWith("@font-face { font-family: '") && line.includes("src: url('/fonts/"))
        continue;
      if (!declaration.test(line)) out.push(`outside the grammar: ${line}`);
    }
    return out;
  }

  it('maps the default theme and every preset completely', () => {
    for (const theme of [DEFAULT_THEME, ...Object.values(THEME_PRESETS)])
      expect(problems(theme as ResolvedTheme)).toEqual([]);
  });

  it('loads Source Serif only for the serif pair, and both palettes explicitly', () => {
    expect(themeCss(DEFAULT_THEME)).not.toContain('Source Serif');
    const editorial = themeCss(THEME_PRESETS.editorial as ResolvedTheme);
    expect(editorial).toContain("font-family: 'Source Serif 4'");
    expect(editorial).toContain(`--color-link: ${THEME_PRESETS.editorial.palettes.dark.link};`);
  });

  it('stays inside the grammar for random valid themes', () => {
    // A seeded generator: reproducible, and every value inside the validated ranges.
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const between = (min: number, max: number) => min + random() * (max - min);
    for (let i = 0; i < 200; i += 1) {
      const theme: ResolvedTheme = {
        ...DEFAULT_THEME,
        fontPair: random() < 0.5 ? 'inter' : 'source-serif-inter',
        baseSize: between(THEME_RANGES.baseSize.min, THEME_RANGES.baseSize.max),
        scaleRatio: between(THEME_RANGES.scaleRatio.min, THEME_RANGES.scaleRatio.max),
        measure: between(THEME_RANGES.measure.min, THEME_RANGES.measure.max),
        radius: between(THEME_RANGES.radius.min, THEME_RANGES.radius.max),
        density: between(THEME_RANGES.density.min, THEME_RANGES.density.max),
        headingWeight: ([400, 500, 600, 700, 800] as const)[Math.floor(random() * 5)]!,
      };
      // The same values a write would accept (contrast is unchanged from the default).
      expect(Theme.safeParse(theme).success).toBe(true);
      expect(problems(theme)).toEqual([]);
    }
  });
});
