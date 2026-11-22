// The translation table from WordPress blocks to Mycel blocks (brief wordpress-import-execution
// § Ontwerpkeuzes 5): one entry per block name, each tested on its own. An entry returns Mycel
// blocks with every localised field in one locale, header fields for the document (ADR 025:
// `wings/hero` becomes title, lead and hero image, never the `hero` block), or a reason to leave
// the block out. Nothing is guessed: a block without an entry is left out and reported with its
// name and position, and the props an entry makes are validated against the core's schemas by
// the planner. Rejected: rendering an unknown block to HTML and keeping it as text (the layout
// would be lost silently, and a `wings/nodes-grid` holds a query, not words).

import { slugFromTitle, type BlockType } from '@mycel/core';
import type { WpBlock } from './grammar.js';
import { decodeEntities, find, findAll, parseMarkup, textOf, type Node } from './markup.js';
import { docFromHtml, isShortcode, plainText, type LinkRewrite } from './rich.js';

/** A source attachment as the blocks see it: its placeholder id and what WordPress says of it. */
export interface MediaRef {
  ref: string;
  alt: string | null;
  title: string;
}

export interface BlockDraft {
  type: BlockType;
  props: Record<string, unknown>;
}

export interface HeaderDraft {
  lead?: string;
  heroImageId?: string;
  heroAlt?: string;
}

/** Why a block is left out; `empty` is silent, every other reason is a report line. */
export type SkipReason =
  'unsupported' | 'shortcode' | 'alt-missing' | 'media-missing' | 'people-missing' | 'empty';

export type Mapped =
  | { kind: 'blocks'; blocks: BlockDraft[] }
  | { kind: 'header'; header: HeaderDraft }
  | { kind: 'skip'; reason: SkipReason };

export interface MapContext {
  locale: string;
  /** The post's own title, for a video the export gives no title. */
  postTitle: string;
  link: LinkRewrite;
  media(id: unknown): MediaRef | null;
  /** The placeholder id of a post in the export, for a link that names one by id. */
  item(id: unknown): string | null;
  /** The placeholder id of a Wings person or organisation post (MY-281). */
  person(id: unknown): string | null;
  /** The placeholder id of the person group made from a Wings category, by its term id. */
  personGroup(termId: unknown): string | null;
  /** Every imported person or every organisation, in the order Wings lists them (by title). */
  everyone(kind: 'person' | 'organisation'): string[];
  /** A remark on this block that does not leave it out. */
  note(code: NoteCode, detail?: string): void;
}

export type NoteCode =
  | 'image.alt-missing'
  | 'video.title-from-item'
  | 'timeline.date-completed'
  | 'timeline.event-without-date'
  | 'hero.action-dropped'
  | 'people.missing';

type Entry = (block: WpBlock, ctx: MapContext) => Mapped;

const blocks = (...list: BlockDraft[]): Mapped => ({ kind: 'blocks', blocks: list });
const skip = (reason: SkipReason): Mapped => ({ kind: 'skip', reason });
const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
/** The text of an element as one line. */
const words = (node: Node) => textOf(node).replace(/\s+/g, ' ').trim();

function richText(html: string, ctx: MapContext): Mapped {
  const text = plainText(html);
  if (!text) return skip('empty');
  if (isShortcode(text)) return skip('shortcode');
  const doc = docFromHtml(html, ctx.link);
  return doc
    ? blocks({ type: 'rich-text', props: { content: { [ctx.locale]: doc } } })
    : skip('empty');
}

/** The image use of the core and Wings image blocks: alt from the block, else from the file. */
function imageUse(
  id: unknown,
  alt: string,
  decorative: boolean,
  caption: string,
  ctx: MapContext
): Record<string, unknown> | SkipReason {
  const media = ctx.media(id);
  if (!media) return 'media-missing';
  // An alt from block attributes or post meta may still carry entities (`&amp;`); markup is decoded.
  const text = decodeEntities(alt).trim() || media.alt || '';
  if (!decorative && !text) return 'alt-missing';
  return {
    mediaId: media.ref,
    decorative,
    alt: decorative ? null : { [ctx.locale]: text },
    ...(caption && { caption: { [ctx.locale]: caption } }),
  };
}

/** WordPress alignment and Wings layout names to Mycel image layouts. */
function imageLayout(value: string): string {
  return (
    {
      wide: 'wide',
      large: 'wide',
      full: 'full',
      left: 'float-left',
      right: 'float-right',
    }[value] ?? 'content'
  );
}

function coreImage(block: WpBlock, ctx: MapContext): Mapped {
  const root = parseMarkup(block.html, 'html');
  const img = find(root, 'img');
  const caption = words(find(root, 'figcaption') ?? '');
  const use = imageUse(block.attrs.id, img?.attrs.alt?.trim() ?? '', false, caption, ctx);
  if (typeof use === 'string') return skip(use);
  return blocks({ type: 'image', props: { ...use, layout: imageLayout(str(block.attrs.align)) } });
}

function wingsImage(block: WpBlock, ctx: MapContext): Mapped {
  const a = block.attrs;
  const use = imageUse(a.id, str(a.alt), a.decorative === true, plainText(str(a.caption)), ctx);
  if (typeof use === 'string') return skip(use);
  return blocks({ type: 'image', props: { ...use, layout: imageLayout(str(a.layout)) } });
}

function gallery(images: { id: unknown; alt: string; caption: string }[], ctx: MapContext): Mapped {
  const uses: Record<string, unknown>[] = [];
  for (const image of images) {
    const use = imageUse(image.id, image.alt, false, image.caption, ctx);
    if (use === 'alt-missing') ctx.note('image.alt-missing', String(image.id));
    if (typeof use !== 'string') uses.push(use);
  }
  return blocks({ type: 'gallery', props: { images: uses } });
}

function coreGallery(block: WpBlock, ctx: MapContext): Mapped {
  const inner = block.innerBlocks.filter((b) => b.name === 'core/image');
  if (inner.length)
    return gallery(
      inner.map((b) => {
        const root = parseMarkup(b.html, 'html');
        return {
          id: b.attrs.id,
          alt: find(root, 'img')?.attrs.alt?.trim() ?? '',
          caption: words(find(root, 'figcaption') ?? ''),
        };
      }),
      ctx
    );
  // Before WordPress 5.9 a gallery was one block with the attachment ids in its attributes.
  const ids = Array.isArray(block.attrs.ids) ? block.attrs.ids : [];
  return gallery(
    ids.map((id) => ({ id, alt: '', caption: '' })),
    ctx
  );
}

function wingsGallery(block: WpBlock, ctx: MapContext): Mapped {
  const images = Array.isArray(block.attrs.images) ? block.attrs.images : [];
  return gallery(
    images.map((i: Record<string, unknown>) => ({
      id: i.id,
      alt: str(i.alt),
      caption: plainText(str(i.caption)),
    })),
    ctx
  );
}

/** The provider and id of a YouTube or Vimeo address, or null for anything else. */
export function videoOf(url: string): { provider: 'youtube' | 'vimeo'; videoId: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') return youtube(u.pathname.slice(1));
  if (host === 'youtube.com' || host === 'youtube-nocookie.com')
    return youtube(u.searchParams.get('v') ?? u.pathname.split('/')[2] ?? '');
  const vimeo = /^\/(?:video\/)?(\d{1,20})/.exec(u.pathname);
  if ((host === 'vimeo.com' || host === 'player.vimeo.com') && vimeo)
    return { provider: 'vimeo', videoId: vimeo[1]! };
  return null;
}
const youtube = (id: string) =>
  /^[A-Za-z0-9_-]{11}$/.test(id) ? { provider: 'youtube' as const, videoId: id } : null;

function video(url: string, caption: string, ctx: MapContext): Mapped {
  const found = videoOf(url);
  if (!found) return skip('unsupported');
  if (!caption) ctx.note('video.title-from-item');
  return blocks({
    type: 'video-embed',
    props: { ...found, title: { [ctx.locale]: caption || ctx.postTitle } },
  });
}

function coreQuote(block: WpBlock, ctx: MapContext): Mapped {
  const cite = find(parseMarkup(block.html, 'html'), 'cite');
  const name = cite ? words(cite) : '';
  const text = plainText(block.html.replace(/<cite[\s\S]*?<\/cite>/gi, ''));
  return blocks({
    type: 'quote',
    props: { text: { [ctx.locale]: text }, attribution: { name } },
  });
}

function wingsBlockquote(block: WpBlock, ctx: MapContext): Mapped {
  // The source of a quote is a web address of its own; a link into the site is not one.
  const url = str(block.attrs.sourceUrl);
  return blocks({
    type: 'quote',
    props: {
      text: { [ctx.locale]: plainText(str(block.attrs.quote)) },
      attribution: {
        name: plainText(str(block.attrs.source)),
        ...(/^https?:\/\//i.test(url) && { url }),
      },
    },
  });
}

function callout(block: WpBlock, ctx: MapContext): Mapped {
  const doc = docFromHtml(str(block.attrs.content) || block.html, ctx.link);
  if (!doc) return skip('empty');
  return blocks({ type: 'callout', props: { body: { [ctx.locale]: doc } } });
}

/** A Wings link object (`{ id, url, title }`) or a bare URL as a card action target. */
function target(link: unknown, url: string, ctx: MapContext) {
  const id = (link as { id?: unknown } | null | undefined)?.id;
  const itemId = ctx.item(id);
  if (itemId) return { kind: 'item', itemId };
  const to = ctx.link(str((link as { url?: unknown } | null | undefined)?.url) || url);
  if (!to) return null;
  return 'itemId' in to ? { kind: 'item', itemId: to.itemId } : { kind: 'url', url: to.href };
}

function cta(block: WpBlock, ctx: MapContext): Mapped {
  const a = block.attrs;
  const actions = [
    [str(a.buttonText), target(a.link, str(a.url), ctx)],
    [str(a.secondaryButtonText), target(a.secondaryLink, str(a.secondaryUrl), ctx)],
  ]
    .filter(([label, to]) => label && to)
    .map(([label, to]) => ({ label: { [ctx.locale]: label }, target: to }));
  const body = plainText(str(a.description));
  return blocks({
    type: 'cta',
    props: {
      title: { [ctx.locale]: plainText(str(a.title)) },
      ...(body && { body: { [ctx.locale]: body } }),
      actions,
    },
  });
}

function faq(block: WpBlock, ctx: MapContext): Mapped {
  const items = Array.isArray(block.attrs.faqItems) ? block.attrs.faqItems : [];
  const title = plainText(str(block.attrs.title));
  return blocks({
    type: 'faq',
    props: {
      ...(title && { title: { [ctx.locale]: title } }),
      entries: items.map((e: Record<string, unknown>) => ({
        question: { [ctx.locale]: plainText(str(e.question)) },
        answer: { [ctx.locale]: docFromHtml(str(e.answer), ctx.link) },
      })),
    },
  });
}

function timeline(block: WpBlock, ctx: MapContext): Mapped {
  const events = Array.isArray(block.attrs.events) ? block.attrs.events : [];
  const title = plainText(str(block.attrs.title));
  const out = [];
  for (const e of events as Record<string, unknown>[]) {
    const raw = str(e.date);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? raw
      : /^\d{4}-\d{2}$/.test(raw)
        ? `${raw}-01`
        : /^\d{4}$/.test(raw)
          ? `${raw}-01-01`
          : null;
    if (!date) {
      ctx.note('timeline.event-without-date', str(e.title));
      continue;
    }
    if (date !== raw) ctx.note('timeline.date-completed', raw);
    const body = plainText(str(e.description));
    out.push({
      date,
      title: { [ctx.locale]: plainText(str(e.title)) },
      ...(body && { body: { [ctx.locale]: body } }),
    });
  }
  return blocks({
    type: 'timeline',
    props: { ...(title && { title: { [ctx.locale]: title } }), events: out },
  });
}

function hero(block: WpBlock, ctx: MapContext): Mapped {
  const a = block.attrs;
  const image = a.heroImage as { id?: unknown; alt?: unknown } | undefined;
  const media = image?.id ? ctx.media(image.id) : null;
  const alt = decodeEntities(str(image?.alt)).trim() || media?.alt || '';
  if (str(a.ctaText)) ctx.note('hero.action-dropped', str(a.ctaText));
  const lead = plainText(str(a.introText));
  return {
    kind: 'header',
    header: {
      ...(lead && { lead }),
      ...(media && { heroImageId: media.ref }),
      ...(media && alt && { heroAlt: alt }),
    },
  };
}

/**
 * A Wings people grid as a `people-grid` (MY-281): a category becomes the person group made from
 * it, a selection keeps its order, and "all" is every imported entry of that kind. A card in Wings
 * shows a role, an organisation's description and the social links; `showName` and `showImage`
 * have no counterpart, because a Mycel card always names its person.
 */
function peopleGrid(block: WpBlock, ctx: MapContext): Mapped {
  const a = block.attrs;
  const organisations = a.contentType === 'organizations';
  const look = {
    columns: String(Math.min(4, Math.max(2, Math.round(Number(a.columns) || 4)))),
    showRole: true,
    showBio: organisations,
    showContact: a.showSocialMedia !== false,
  };
  const mode = str(a.displayMode) || 'all';
  if (mode === 'category') {
    const groupId = ctx.personGroup(a.selectedCategory);
    return groupId
      ? blocks({ type: 'people-grid', props: { source: 'group', groupId, people: [], ...look } })
      : skip('people-missing');
  }
  let refs: string[];
  if (mode === 'selected') {
    refs = [];
    for (const id of Array.isArray(a.selectedItems) ? a.selectedItems : []) {
      const ref = ctx.person(id);
      if (!ref) ctx.note('people.missing', String(id));
      else if (!refs.includes(ref)) refs.push(ref);
    }
  } else refs = ctx.everyone(organisations ? 'organisation' : 'person').slice(0, 100);
  if (!refs.length) return skip('people-missing');
  return blocks({
    type: 'people-grid',
    props: {
      source: 'selection',
      groupId: null,
      people: refs.map((personId) => ({ personId })),
      ...look,
    },
  });
}

function file(block: WpBlock, ctx: MapContext): Mapped {
  const media = ctx.media(block.attrs.id);
  if (!media) return skip('media-missing');
  const link = findAll(parseMarkup(block.html, 'html'), 'a').find((a) => !a.attrs.download);
  const name = (link && words(link)) || media.title;
  return blocks({
    type: 'file-download',
    props: { files: [{ fileId: media.ref, name: { [ctx.locale]: name } }] },
  });
}

function audio(block: WpBlock, ctx: MapContext): Mapped {
  const media = ctx.media(block.attrs.id);
  if (!media) return skip('media-missing');
  const caption = words(find(parseMarkup(block.html, 'html'), 'figcaption') ?? '');
  return blocks({
    type: 'audio',
    props: { title: { [ctx.locale]: caption || media.title }, fileId: media.ref },
  });
}

/** Classic-editor HTML has paragraphs as blank lines (wpautop); give them their `<p>` first. */
function freeform(block: WpBlock, ctx: MapContext): Mapped {
  const html = /<(p|ul|ol|h[1-6])[\s>]/i.test(block.html)
    ? block.html
    : block.html
        .split(/\n\s*\n/)
        .map((chunk) => `<p>${chunk.trim().replace(/\n/g, '<br>')}</p>`)
        .join('');
  return richText(html, ctx);
}

export const BLOCK_MAP: Record<string, Entry> = {
  'core/paragraph': (b, ctx) => richText(b.html, ctx),
  'core/list': (b, ctx) => richText(b.html, ctx),
  'core/heading': (b, ctx) => {
    const text = plainText(b.html);
    return text
      ? blocks({ type: 'heading', props: { text: { [ctx.locale]: text } } })
      : skip('empty');
  },
  'core/image': coreImage,
  'wings/image': wingsImage,
  'core/gallery': coreGallery,
  'wings/image-gallery': wingsGallery,
  'wings/privacy-video': (b, ctx) =>
    video(
      str(b.attrs.url) ||
        (b.attrs.provider === 'vimeo'
          ? `https://vimeo.com/${str(b.attrs.videoId)}`
          : `https://youtu.be/${str(b.attrs.videoId)}`),
      '',
      ctx
    ),
  'core/embed': (b, ctx) =>
    video(str(b.attrs.url), words(find(parseMarkup(b.html, 'html'), 'figcaption') ?? ''), ctx),
  'core/quote': coreQuote,
  'wings/blockquote': wingsBlockquote,
  'wings/callout': callout,
  'wings/cta': cta,
  'wings/faq': faq,
  'wings/timeline': timeline,
  'wings/hero': hero,
  'wings/people-organizations-grid': peopleGrid,
  'core/file': file,
  'core/audio': audio,
  'core/shortcode': () => skip('shortcode'),
};

/**
 * Layout containers whose inner blocks are the content (MY-282): the planner maps the inner blocks
 * in the container's place, so a section of headings and paragraphs in a group keeps its text. A
 * Mycel page has no group or column block, so what the container itself carried (a class, a
 * colour) is a report line, see `lookOf`. Rejected: leaving the container out whole (a Dreamkit
 * front page that puts every section in a group lost all its text) and a `section` block of our
 * own (a layout wrapper is not a content type, ADR 013 offers block variants instead).
 */
export const CONTAINERS = new Set(['core/group', 'core/columns', 'core/column']);

const LOOK = ['className', 'backgroundColor', 'textColor', 'gradient', 'style'] as const;

/** What a container carried that the unwrapped blocks lose, as `key=value` pairs; null if none. */
export function lookOf(block: WpBlock): string | null {
  const pairs = LOOK.filter((key) => block.attrs[key] !== undefined).map((key) => {
    const value = block.attrs[key];
    return `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`;
  });
  return pairs.length ? pairs.join(' ') : null;
}

/** Map one top-level block; freeform HTML has no name. */
export function mapBlock(block: WpBlock, ctx: MapContext): Mapped {
  if (block.name === null) return freeform(block, ctx);
  const entry = BLOCK_MAP[block.name];
  return entry ? entry(block, ctx) : skip('unsupported');
}

/** A WordPress post name as written; WordPress percent-encodes letters outside ASCII. */
export function decodedSlug(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** A slug the core accepts, from a WordPress post name, else from the title. */
export function slugOf(name: string, title: string): string {
  return slugFromTitle(decodedSlug(name)) || slugFromTitle(title);
}
