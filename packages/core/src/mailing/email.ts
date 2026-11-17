// An item as a newsletter e-mail (ADR 010 rule 6, ADR 012 rule 5): one locale of one revision
// with every tenant reference resolved, as plain data an `EmailRenderer` turns into table HTML and
// a text part. The core decides what a block becomes in mail; the renderer only decides markup
// (ADR 004 rule 2), so a second renderer (or a test) sees the same choices.
//
// What mail cannot carry becomes one sentence with a link: a form, a campaign card, audio, an
// overview, a people grid and a file list link to the item's web version (the "read in browser"
// copy and its archive); a video links to the video itself. A paywall adds nothing: restricted
// items are not sent. References fail closed as on the site: a restricted,
// deleted or unready image is left out, and a link to an item that is not published and public in
// this locale stays text.
//
// Rejected: rendering from the web's render model (`apps/web/src/lib/blocks`), which the send use
// case cannot reach (sending renders inside the core), and copying its full resolver: mail
// needs one image size and plain links, not forms, counters or srcsets.

import { z } from 'zod';
import { notFound } from '../errors.js';
import { Locale } from '../i18n/locale.js';
import { defineUseCase } from '../registry.js';
import { exampleId } from '../util/ids.js';
import { allBlocks, type Block, type BlockProps, type BlockType } from '../content/blocks.js';
import { statusOf } from '../content/lifecycle.js';
import type { ContentDocument } from '../content/model.js';
import { contentPath } from '../content/public.js';
import type { RichTextDoc } from '../content/rich-text.js';
import { linkedItemIds } from '../content/rich-text.js';
import { t, type MessageKey } from '../i18n/index.js';
import { creditKind, variantFile, type MediaCredit, type MediaRecord } from '../media/model.js';
import type { TransactionContext } from '../ports.js';
import { resolveTheme } from '../theme/contrast.js';
import '../content/ports.js';
import '../media/ports.js';
import '../theme/ports.js';
import './ports.js';

/** The widest image a mail asks for: twice the 600 px column. */
const EMAIL_IMAGE_WIDTH = 1200;

/** Where the mail points: site name, absolute root without trailing slash, default locale. */
export const EmailSite = z
  .object({
    name: z.string().min(1).max(200),
    url: z
      .string()
      .url()
      .regex(/^https?:\/\//)
      .refine((u) => !u.endsWith('/'), 'no trailing slash'),
    defaultLocale: z.string().min(2).max(10),
  })
  .strict();
export type EmailSite = z.infer<typeof EmailSite>;

export interface EmailImage {
  /** Absolute URL of a WebP variant. */
  src: string;
  /** `''` for a decorative image. */
  alt: string;
  width: number;
  height: number;
  caption: string | null;
  credit: string | null;
}

export interface EmailAction {
  label: string;
  /** Absolute URL. */
  href: string;
}

export type EmailBlock =
  | { type: 'heading'; text: string }
  | { type: 'rich-text'; doc: RichTextDoc }
  | { type: 'image'; image: EmailImage }
  | { type: 'gallery'; images: EmailImage[] }
  | {
      /** A hero, call to action, card or timeline event: a titled box with buttons. */
      type: 'panel';
      tone: 'plain' | 'accent';
      label: string | null;
      title: string;
      body: string | null;
      image: EmailImage | null;
      actions: EmailAction[];
    }
  | {
      type: 'callout';
      tone: 'info' | 'note' | 'warning';
      label: string;
      title: string | null;
      doc: RichTextDoc;
    }
  | { type: 'qa'; question: string; answer: RichTextDoc }
  | { type: 'quote'; text: string; cite: string | null }
  /** What mail cannot show: one sentence linking to where it can be seen. */
  | { type: 'link'; text: string; href: string };

export type EmailTone = { foreground: string; background: string };

export interface EmailDocument {
  locale: string;
  subject: string;
  title: string;
  lead: string | null;
  hero: EmailImage | null;
  blocks: EmailBlock[];
  /** Item id to absolute URL, or null when that item is not public here: the text stays text. */
  links: Record<string, string | null>;
  /** This locale of the item on the site, the "read in browser" link. */
  webUrl: string;
  site: { name: string; url: string };
  theme: {
    body: EmailTone;
    surface: EmailTone;
    primary: EmailTone;
    accent: EmailTone;
    muted: EmailTone;
    warning: EmailTone;
    link: string;
    headingFont: 'sans' | 'serif';
  };
  copy: { viewInBrowser: string; footer: string; footnotes: string };
  /**
   * The unsubscribe link of the footer, on a mail that goes to a list (ADR 010 rule 8); absent
   * on a rendering that is not one. `href` may be `UNSUBSCRIBE_PLACEHOLDER`.
   */
  unsubscribe?: EmailAction;
}

/**
 * Stands where a recipient's own unsubscribe link goes. An edition is rendered once and is the
 * same for everyone (ADR 018 rule 4); the delivery puts each recipient's signed link here, in
 * the HTML and in the text part. A valid address without a character HTML escapes, so every
 * renderer passes it through unchanged. `.invalid` never resolves (RFC 2606).
 */
export const UNSUBSCRIBE_PLACEHOLDER = 'https://unsubscribe.invalid/recipient';

/** A rendered mail with `url` where the placeholder stood; the HTML gets it escaped. */
export function withUnsubscribeUrl(mail: RenderedEmail, url: string): RenderedEmail {
  const escaped = url
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return {
    html: mail.html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, escaped),
    text: mail.text.replaceAll(UNSUBSCRIBE_PLACEHOLDER, url),
  };
}

/** The rendered mail; the port's answer. */
export interface RenderedEmail {
  html: string;
  text: string;
}

/** Types that become a link to the web version; `emailBlocks` makes every new type choose. */
export const EMAIL_FALLBACK_TYPES: readonly BlockType[] = [
  'form',
  'signup-form',
  'campaign-card',
  'audio',
  'overview',
  'people-grid',
  'file-download',
];

/**
 * The public site-root path of an item in a locale, or null: published in that locale, the rule
 * of `content.published.get`. A restricted item has an address (its teaser, ADR 016 rule 3), so a
 * link to it is a link; a zone has none.
 */
export async function publicItemPath(
  ctx: TransactionContext,
  itemId: string,
  locale: string,
  defaultLocale: string
): Promise<string | null> {
  const item = await ctx.content.get(itemId);
  if (!item || item.profile === 'zone') return null;
  const state = item.publication.find((s) => s.locale === locale && statusOf(s) === 'published');
  if (!state?.publishedRevisionId) return null;
  return contentPath(item, locale, defaultLocale);
}

/** A credit as one line, in the words the site uses ('Foto: {name}'). */
export function emailCredit(credit: MediaCredit | undefined | null, locale: string): string | null {
  if (!credit) return null;
  const words: Record<ReturnType<typeof creditKind>, MessageKey> = {
    photo: 'mail.email.credit.photo',
    illustration: 'mail.email.credit.illustration',
    other: 'mail.email.credit.other',
  };
  const line = [
    credit.work ? `${credit.work.title}, ${credit.work.maker}` : null,
    credit.photographer
      ? t(locale, words[creditKind(credit)], { name: credit.photographer })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return line || null;
}

type Localized<T> = Partial<Record<string, T>> | undefined;

/**
 * One locale of `doc` as mail. `doc` is the revision to show: the latest for a preview, the
 * published one for a send. Values missing in the locale are left out, as a preview does.
 */
export async function emailDocument(
  ctx: TransactionContext,
  input: {
    item: { id: string; type: 'page' | 'article'; slug: string };
    doc: ContentDocument;
    locale: string;
    site: EmailSite;
    /** Where the footer's unsubscribe link points; without it the mail has none. */
    unsubscribe?: string;
  }
): Promise<EmailDocument> {
  const { item, doc, locale, site } = input;
  const l = <T>(m: Localized<T>): T | undefined => m?.[locale];
  const abs = (href: string) => (href.startsWith('/') ? `${site.url}${href}` : href);
  const webUrl = abs(contentPath(item, locale, site.defaultLocale));
  const copy = (key: MessageKey, params?: Record<string, string>) => t(locale, key, params);

  const blocks = allBlocks(doc.blocks);
  const itemIds = new Set<string>();
  for (const b of blocks) for (const id of itemRefs(b)) itemIds.add(id);
  const links: Record<string, string | null> = {};
  for (const id of itemIds) {
    const path = await publicItemPath(ctx, id, locale, site.defaultLocale);
    links[id] = path === null ? null : abs(path);
  }

  const images = new Map<string, Awaited<ReturnType<typeof mediaOf>>>();
  const asset = async (mediaId: string) => {
    if (!images.has(mediaId)) images.set(mediaId, await mediaOf(ctx, mediaId, abs));
    return images.get(mediaId) ?? null;
  };
  const image = async (use: {
    mediaId: string;
    decorative?: boolean | undefined;
    alt: Localized<string> | null;
    caption?: Localized<string> | undefined;
    credit?: MediaCredit | undefined;
  }): Promise<EmailImage | null> => {
    const found = await asset(use.mediaId);
    if (!found) return null;
    const { record, ...size } = found;
    const caption = use.caption ? l(use.caption) : l(record.caption);
    return {
      ...size,
      alt: use.decorative ? '' : (l(use.alt ?? undefined) ?? ''),
      caption: caption || null,
      credit: emailCredit(use.credit ?? record.credit, locale),
    };
  };
  const actions = (list: readonly BlockProps<'cta'>['actions'][number][]): EmailAction[] =>
    list.flatMap((a) => {
      const label = l(a.label);
      const href = a.target.kind === 'item' ? links[a.target.itemId] : abs(a.target.url);
      return label && href ? [{ label, href }] : [];
    });
  const web = (key: MessageKey, params?: Record<string, string>): EmailBlock => ({
    type: 'link',
    text: copy(key, params),
    href: webUrl,
  });

  const out: EmailBlock[] = [];
  for (const b of doc.blocks) out.push(...(await emailBlocks(b)));

  const theme = resolveTheme((await ctx.siteSettings.theme()).value);
  const p = theme.palettes.light;
  const heroImage = doc.heroImageId
    ? await image({
        mediaId: doc.heroImageId,
        decorative: !l(doc.heroAlt),
        alt: doc.heroAlt ?? null,
      })
    : null;

  return {
    locale,
    subject: ('delivery' in doc ? l(doc.delivery.email?.subject) : undefined) ?? l(doc.title) ?? '',
    title: l(doc.title) ?? '',
    lead: l(doc.lead) ?? null,
    hero: heroImage,
    blocks: out,
    links,
    webUrl,
    site: { name: site.name, url: site.url },
    theme: {
      body: p.body,
      surface: p.surface,
      primary: p.primary,
      accent: p.accent,
      muted: p.muted,
      warning: p.warning,
      link: p.link,
      headingFont: theme.fontPair === 'source-serif-inter' ? 'serif' : 'sans',
    },
    copy: {
      viewInBrowser: copy('mail.email.viewInBrowser'),
      footer: copy('mail.email.footer', { site: site.name }),
      footnotes: copy('mail.email.footnotes'),
    },
    ...(input.unsubscribe
      ? { unsubscribe: { label: copy('mail.email.unsubscribe'), href: input.unsubscribe } }
      : {}),
  };

  async function emailBlocks(b: Block): Promise<EmailBlock[]> {
    switch (b.type) {
      case 'heading': {
        const text = l(b.props.text);
        return text ? [{ type: 'heading', text }] : [];
      }
      case 'rich-text': {
        const d = l(b.props.content);
        return d ? [{ type: 'rich-text', doc: d }] : [];
      }
      case 'paywall':
        return [];
      case 'image': {
        const img = await image(b.props);
        return img ? [{ type: 'image', image: img }] : [];
      }
      case 'gallery': {
        const list: EmailImage[] = [];
        for (const i of b.props.images) {
          const img = await image(i);
          if (img) list.push(img);
        }
        return list.length ? [{ type: 'gallery', images: list }] : [];
      }
      case 'hero':
      case 'cta': {
        const title = l(b.props.title);
        if (!title) return [];
        const heroImage = b.type === 'hero' && b.props.image ? await image(b.props.image) : null;
        return [
          {
            type: 'panel',
            tone: b.type === 'cta' ? 'accent' : 'plain',
            label: null,
            title,
            body: l(b.props.body) ?? null,
            image: heroImage,
            actions: actions(b.props.actions),
          },
        ];
      }
      case 'cards':
        return b.props.cards.flatMap((c): EmailBlock[] => {
          const title = l(c.title);
          return title
            ? [
                {
                  type: 'panel',
                  tone: b.props.accent === 'none' ? 'plain' : 'accent',
                  label: null,
                  title,
                  body: l(c.body) ?? null,
                  image: null,
                  actions: actions(c.actions),
                },
              ]
            : [];
        });
      case 'timeline': {
        const title = l(b.props.title);
        const events = [...b.props.events].sort((x, y) =>
          b.props.order === 'newest' ? y.date.localeCompare(x.date) : x.date.localeCompare(y.date)
        );
        return [
          ...(title ? [{ type: 'heading', text: title } as const] : []),
          ...events.flatMap((e): EmailBlock[] => {
            const eventTitle = l(e.title);
            return eventTitle
              ? [
                  {
                    type: 'panel',
                    tone: 'plain',
                    label: new Intl.DateTimeFormat(locale, {
                      dateStyle: 'long',
                      timeZone: 'UTC',
                    }).format(new Date(`${e.date}T00:00:00Z`)),
                    title: eventTitle,
                    body: l(e.body) ?? null,
                    image: null,
                    actions: actions(e.actions),
                  },
                ]
              : [];
          }),
        ];
      }
      case 'callout': {
        const d = l(b.props.body);
        return d
          ? [
              {
                type: 'callout',
                tone: b.props.variant,
                label: copy(`mail.email.callout.${b.props.variant}`),
                title: l(b.props.title) ?? null,
                doc: d,
              },
            ]
          : [];
      }
      case 'faq': {
        const title = l(b.props.title);
        return [
          ...(title ? [{ type: 'heading', text: title } as const] : []),
          ...b.props.entries.flatMap((e): EmailBlock[] => {
            const question = l(e.question);
            const answer = l(e.answer);
            return question && answer ? [{ type: 'qa', question, answer }] : [];
          }),
        ];
      }
      case 'quote': {
        const text = l(b.props.text);
        if (!text) return [];
        const a = b.props.attribution;
        const who = [a.name, l(a.role)].filter(Boolean).join(', ');
        const source = l(a.source);
        const cite = [who, source].filter(Boolean).join(', ');
        return [{ type: 'quote', text, cite: cite || null }];
      }
      case 'video-embed': {
        const title = l(b.props.title) ?? '';
        return [
          {
            type: 'link',
            text: copy('mail.email.web.video', { title }),
            href:
              b.props.provider === 'youtube'
                ? `https://www.youtube.com/watch?v=${encodeURIComponent(b.props.videoId)}`
                : `https://vimeo.com/${encodeURIComponent(b.props.videoId)}`,
          },
        ];
      }
      case 'form':
      case 'signup-form':
        return [web('mail.email.web.form')];
      case 'campaign-card':
        return [web('mail.email.web.campaign')];
      case 'audio':
        return [web('mail.email.web.audio', { title: l(b.props.title) ?? '' })];
      case 'overview':
      case 'people-grid':
      case 'file-download':
        return [web('mail.email.web.more')];
      default:
        return b satisfies never;
    }
  }
}

/** The item ids a block links to: actions and links inside rich text, every locale. */
function itemRefs(b: Block): string[] {
  const docs = (m: Localized<RichTextDoc>) =>
    Object.values(m ?? {}).flatMap((d) => (d ? linkedItemIds(d) : []));
  const acts = (list: readonly { target: { kind: string; itemId?: string } }[]) =>
    list.flatMap((a) => (a.target.kind === 'item' && a.target.itemId ? [a.target.itemId] : []));
  switch (b.type) {
    case 'rich-text':
      return docs(b.props.content);
    case 'callout':
      return docs(b.props.body);
    case 'faq':
      return b.props.entries.flatMap((e) => docs(e.answer));
    case 'hero':
    case 'cta':
      return acts(b.props.actions);
    case 'cards':
      return b.props.cards.flatMap((c) => acts(c.actions));
    case 'timeline':
      return b.props.events.flatMap((e) => acts(e.actions));
    default:
      return [];
  }
}

/** A public, ready image's widest WebP variant up to the mail's width; anything else is none. */
async function mediaOf(
  ctx: TransactionContext,
  mediaId: string,
  abs: (path: string) => string
): Promise<(Pick<EmailImage, 'src' | 'width' | 'height'> & { record: MediaRecord }) | null> {
  const asset = await ctx.media.get(mediaId);
  if (!asset || asset.deletedAt || asset.access !== 'public') return null;
  if (asset.kind !== 'image' || asset.state !== 'ready') return null;
  const sized = asset.variants
    .filter((v) => v.format === 'webp' && /^w\d+$/.test(v.name) && v.width && v.height)
    .sort((a, b) => a.width! - b.width!);
  const best = [...sized].reverse().find((v) => v.width! <= EMAIL_IMAGE_WIDTH) ?? sized[0];
  if (!best) return null;
  return {
    src: abs(ctx.delivery.variantPath(asset.id, variantFile(best))),
    width: best.width!,
    height: best.height!,
    record: asset,
  };
}

export const getEmail = defineUseCase({
  name: 'mailing.email.get',
  kind: 'query',
  description:
    "Render one locale of an item's latest revision as the newsletter e-mail it would become: subject, HTML and text part. Sends nothing; `site` is the site's name, absolute root URL and default locale, which the links in the mail point at.",
  requires: 'content:read',
  input: z.object({ itemId: z.string().guid(), locale: Locale, site: EmailSite }).strict(),
  output: z.object({ subject: z.string(), html: z.string(), text: z.string() }),
  examples: [
    {
      input: {
        itemId: exampleId(0x1),
        locale: 'nl',
        site: { name: 'Probe', url: 'https://probe.example.org', defaultLocale: 'nl' },
      },
    },
  ],
  async handler(ctx, { itemId, locale, site }) {
    const item = await ctx.content.get(itemId);
    if (!item) throw notFound('content item');
    const revision = await ctx.content.revision(itemId, item.latestRevisionId);
    if (!revision) throw notFound('revision');
    const email = await emailDocument(ctx, { item, doc: revision.document, locale, site });
    return { subject: email.subject, ...ctx.emailRenderer.render(email) };
  },
});
