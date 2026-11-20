// From a WordPress export to an import plan: the media, people, sections and content items a
// tenant would get, with every reference between them as a placeholder id, plus a report of what
// does not come over cleanly. Planning writes nothing; executing the plan through the use-case
// registry is a separate step (brief wordpress-import-execution, PR 2), which swaps each
// placeholder for the id the use case returns.
//
// Placeholders are deterministic guids per kind and source id (`00000000-0000-4000-8001-…`), so
// the plan of one export is the same every run and every block and document validates against the
// core's own schemas now, with the references in place. Rejected: symbolic references such as
// `{ wpMedia: 12 }` inside the props (no schema would accept them, so validation would wait until
// execution and the dry run would report less than the real run finds).
//
// Translations (ADR 007): a Polylang pair becomes one item when every language yields the same
// sequence of block types; the localised fields then sit side by side, and a value that is not
// localised and differs between them keeps the default language's and is reported. A pair that
// differs in structure keeps the default language only and reports the other (§ Ontwerpkeuzes 4).

import {
  BLOCK_DEFINITIONS,
  ContentDocumentInput,
  Locale,
  Tags,
  isReservedPageSlug,
  type ContentType,
} from '@mycel/core';
import type { z } from 'zod';
import {
  decodedSlug,
  mapBlock,
  slugOf,
  type BlockDraft,
  type HeaderDraft,
  type MapContext,
  type MediaRef,
  type NoteCode,
} from './blocks.js';
import { parseBlocks } from './grammar.js';
import { linkRewriter, normalPath, plainText } from './rich.js';
import { readWxr, type WxrPost } from './wxr.js';

export interface PlannedMedia {
  ref: string;
  sourceId: number;
  url: string;
  filename: string;
  title: string;
  alt: string | null;
}

export interface PlannedPerson {
  ref: string;
  sourceLogin: string;
  name: string;
}

export interface PlannedSection {
  ref: string;
  sourceSlug: string;
  title: Record<string, string>;
}

export interface PlannedItem {
  ref: string;
  /** The WordPress posts this item comes from, one per locale. */
  sources: { id: number; locale: string }[];
  slug: string;
  status: 'published' | 'draft';
  /** When WordPress first published it; null for a draft. */
  publishedAt: string | null;
  document: z.input<typeof ContentDocumentInput>;
}

export type ReportCode =
  | NoteCode
  | 'block.skipped'
  | 'block.shortcode'
  | 'block.invalid'
  | 'block.media-missing'
  | 'hero.extra'
  | 'item.invalid'
  | 'item.private'
  | 'item.scheduled'
  | 'item.slug-changed'
  | 'item.parent-flattened'
  | 'item.section-extra'
  | 'item.tag-invalid'
  | 'item.excerpt-too-long'
  | 'translation.not-merged'
  | 'translation.value-differs'
  // What happened while executing the plan against a tenant (execute.ts).
  | 'media.failed'
  | 'person.failed'
  | 'section.failed'
  | 'item.failed'
  | 'item.blocks-failed'
  | 'item.publish-failed'
  | 'item.image-missing'
  | 'block.reference-missing';

export interface ReportLine {
  code: ReportCode;
  postId?: number;
  title?: string;
  locale?: string;
  /** The WordPress block name, with its 1-based position among the post's top-level blocks. */
  block?: string;
  position?: number;
  detail?: string;
}

export interface ImportPlan {
  site: { title: string; url: string };
  defaultLocale: string;
  locales: string[];
  media: PlannedMedia[];
  people: PlannedPerson[];
  sections: PlannedSection[];
  items: PlannedItem[];
  report: ReportLine[];
}

export interface PlanOptions {
  /** The site's main language; else the first Polylang language, else the channel's language. */
  defaultLocale?: string;
}

const KIND = { media: 1, person: 2, section: 3, item: 4 } as const;

/** The placeholder guid of one source entity; valid as a guid and as a v4 uuid. */
export function placeholder(kind: keyof typeof KIND, n: number): string {
  return `00000000-0000-4000-800${KIND[kind]}-${String(n).padStart(12, '0')}`;
}

const TYPES: Record<string, ContentType> = { page: 'page', post: 'article' };
const SKIPPED_STATUS = new Set(['trash', 'auto-draft', 'inherit']);
/** WordPress's default category, which says nothing about a post. */
const NO_SECTION = new Set(['uncategorized', 'geen-categorie']);
interface Built {
  post: WxrPost;
  locale: string;
  blocks: BlockDraft[];
  header: HeaderDraft;
  lines: ReportLine[];
}

const firstIssue = (error: z.ZodError) => {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid';
};

/** Merge `other` into `base`: maps by key, arrays per index; a differing leaf keeps `base`. */
function mergeInto(base: unknown, other: unknown, path: string, conflicts: string[]): unknown {
  if (Array.isArray(base) && Array.isArray(other)) {
    if (base.length !== other.length) {
      conflicts.push(path);
      return base;
    }
    return base.map((v, i) => mergeInto(v, other[i], `${path}.${i}`, conflicts));
  }
  if (base && other && typeof base === 'object' && typeof other === 'object') {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(other as Record<string, unknown>))
      out[k] = k in out ? mergeInto(out[k], v, `${path}.${k}`, conflicts) : v;
    return out;
  }
  if (base !== other) conflicts.push(path);
  return base;
}

/** Build the plan of a WXR document. Throws only when the file is not a WordPress export. */
export function plan(xml: string, options: PlanOptions = {}): ImportPlan {
  const wxr = readWxr(xml);
  const report: ReportLine[] = [];
  const defaultLocale = options.defaultLocale ?? wxr.site.languages[0] ?? wxr.site.language ?? 'en';
  const localeOf = (post: WxrPost) =>
    post.language && Locale.safeParse(post.language).success ? post.language : defaultLocale;

  const media: PlannedMedia[] = [];
  const mediaById = new Map<number, MediaRef>();
  for (const post of wxr.posts.filter((p) => p.type === 'attachment' && p.attachmentUrl)) {
    const url = post.attachmentUrl!;
    const filename = decodeURIComponent(url.split('/').pop() ?? '') || `${post.id}`;
    const alt = post.meta._wp_attachment_image_alt?.trim() || null;
    const ref = placeholder('media', post.id);
    media.push({ ref, sourceId: post.id, url, filename, title: post.title || filename, alt });
    mediaById.set(post.id, { ref, alt, title: post.title || filename });
  }
  const mediaRef = (id: unknown) => mediaById.get(Number(id)) ?? null;

  // Which posts become items, grouped by translation; the leader is the default language.
  const content = wxr.posts.filter((p) => TYPES[p.type] && !SKIPPED_STATUS.has(p.status));
  const order = (locale: string) => {
    const at = wxr.site.languages.indexOf(locale);
    return locale === defaultLocale ? -1 : at < 0 ? 1000 : at;
  };
  const groups = new Map<string, WxrPost[]>();
  for (const post of content) {
    const key = post.translationGroup ? `${post.type}:${post.translationGroup}` : `#${post.id}`;
    groups.set(key, [...(groups.get(key) ?? []), post]);
  }
  for (const members of groups.values())
    members.sort((a, b) => order(localeOf(a)) - order(localeOf(b)));
  const itemOf = new Map<number, string>();
  const itemAtPath = new Map<string, string>();
  for (const members of groups.values())
    for (const post of members) {
      const ref = placeholder('item', members[0]!.id);
      itemOf.set(post.id, ref);
      try {
        if (post.link) itemAtPath.set(normalPath(new URL(post.link).pathname), ref);
      } catch {
        // A post without a valid address is only reachable by id.
      }
    }
  const link = linkRewriter(wxr.site.url, (path) => itemAtPath.get(path) ?? null);

  const people: PlannedPerson[] = [];
  const personRef = (login: string) => {
    const index = wxr.authors.findIndex((a) => a.login === login);
    if (index < 0) return null;
    const ref = placeholder('person', index + 1);
    if (!people.some((p) => p.ref === ref))
      people.push({ ref, sourceLogin: login, name: wxr.authors[index]!.displayName });
    return ref;
  };
  const sections: PlannedSection[] = [];
  const sectionRef = (slug: string) => {
    const index = wxr.categories.findIndex((c) => c.slug === slug);
    if (index < 0) return null;
    const ref = placeholder('section', index + 1);
    if (!sections.some((s) => s.ref === ref))
      sections.push({
        ref,
        sourceSlug: slug,
        title: { [defaultLocale]: wxr.categories[index]!.name },
      });
    return ref;
  };

  const build = (post: WxrPost): Built => {
    const locale = localeOf(post);
    const lines: ReportLine[] = [];
    const at = { postId: post.id, title: post.title, locale };
    const drafts: BlockDraft[] = [];
    let header: HeaderDraft | null = null;
    parseBlocks(post.content).forEach((block, i) => {
      const where = { ...at, block: block.name ?? 'freeform', position: i + 1 };
      const ctx: MapContext = {
        locale,
        postTitle: post.title,
        link,
        media: mediaRef,
        item: (id) => itemOf.get(Number(id)) ?? null,
        note: (code, detail) => lines.push({ code, ...where, ...(detail && { detail }) }),
      };
      const mapped = mapBlock(block, ctx);
      if (mapped.kind === 'skip') {
        if (mapped.reason === 'empty') return;
        const code = {
          unsupported: 'block.skipped',
          shortcode: 'block.shortcode',
          'alt-missing': 'image.alt-missing',
          'media-missing': 'block.media-missing',
        }[mapped.reason] as ReportCode;
        lines.push({ code, ...where });
      } else if (mapped.kind === 'header') {
        if (header) lines.push({ code: 'hero.extra', ...where });
        else header = mapped.header;
      } else
        for (const draft of mapped.blocks) {
          const result = BLOCK_DEFINITIONS[draft.type].props.safeParse(draft.props);
          if (result.success) drafts.push(draft);
          else lines.push({ code: 'block.invalid', ...where, detail: firstIssue(result.error) });
        }
    });
    // Rich text next to rich text is one block (ADR 020 rule 4); a skipped block between two
    // paragraphs would otherwise leave two.
    const blocks: BlockDraft[] = [];
    for (const draft of drafts) {
      const prev = blocks[blocks.length - 1];
      if (draft.type === 'rich-text' && prev?.type === 'rich-text') {
        const a = (prev.props.content as Record<string, { content: unknown[] }>)[locale]!;
        const b = (draft.props.content as Record<string, { content: unknown[] }>)[locale]!;
        prev.props = {
          content: { [locale]: { type: 'doc', content: [...a.content, ...b.content] } },
        };
      } else blocks.push({ ...draft });
    }
    return { post, locale, blocks, header: header ?? {}, lines };
  };

  const items: PlannedItem[] = [];
  const slugs = new Set<string>();
  for (const members of groups.values()) {
    const [lead, ...rest] = members.map(build);
    const post = lead!.post;
    const type = TYPES[post.type]!;
    const at = { postId: post.id, title: post.title, locale: lead!.locale };
    report.push(...lead!.lines);

    const title: Record<string, string> = { [lead!.locale]: post.title };
    const header = { ...lead!.header };
    const leads: Record<string, string> = header.lead ? { [lead!.locale]: header.lead } : {};
    const heroAlt: Record<string, string> = header.heroAlt
      ? { [lead!.locale]: header.heroAlt }
      : {};
    const excerpts: Record<string, string> = {};
    const excerptOf = (b: Built) => {
      const text = plainText(b.post.excerpt);
      if (text.length > 500)
        report.push({
          code: 'item.excerpt-too-long',
          postId: b.post.id,
          title: b.post.title,
          locale: b.locale,
        });
      else if (text) excerpts[b.locale] = text;
    };
    excerptOf(lead!);
    let blocks: BlockDraft[] = lead!.blocks;
    const locales = [lead!.locale];
    const merged: Built[] = [lead!];
    for (const other of rest) {
      const sameShape =
        other.locale !== lead!.locale &&
        other.blocks.map((b) => b.type).join() === blocks.map((b) => b.type).join() &&
        Boolean(other.header.heroImageId) === Boolean(header.heroImageId);
      if (!sameShape) {
        report.push({
          code: 'translation.not-merged',
          postId: other.post.id,
          title: other.post.title,
          locale: other.locale,
          detail: `item ${post.id}`,
        });
        continue;
      }
      report.push(...other.lines);
      const conflicts: string[] = [];
      blocks = blocks.map((b, i) => ({
        type: b.type,
        props: mergeInto(b.props, other.blocks[i]!.props, `blocks.${i}`, conflicts) as Record<
          string,
          unknown
        >,
      }));
      if (other.header.heroImageId !== header.heroImageId) conflicts.push('heroImageId');
      for (const path of conflicts)
        report.push({
          code: 'translation.value-differs',
          postId: other.post.id,
          title: other.post.title,
          locale: other.locale,
          detail: path,
        });
      locales.push(other.locale);
      merged.push(other);
      title[other.locale] = other.post.title;
      if (other.header.lead) leads[other.locale] = other.header.lead;
      if (other.header.heroAlt) heroAlt[other.locale] = other.header.heroAlt;
      excerptOf(other);
    }

    let slug = slugOf(post.slug, post.title) || `${type}-${post.id}`;
    const original = slug;
    if (type === 'page' && isReservedPageSlug(slug)) slug = `${slug}-page`;
    for (let n = 2; slugs.has(`${type}:${slug}`); n++) slug = `${original}-${n}`;
    slugs.add(`${type}:${slug}`);
    if (post.slug && slug !== decodedSlug(post.slug))
      report.push({ code: 'item.slug-changed', ...at, detail: `${post.slug} → ${slug}` });
    if (post.parent) report.push({ code: 'item.parent-flattened', ...at });
    if (post.status === 'private') report.push({ code: 'item.private', ...at });
    if (post.status === 'future')
      report.push({ code: 'item.scheduled', ...at, detail: post.dateGmt ?? '' });

    const featuredImage = mediaRef(post.meta._thumbnail_id);
    const document: Record<string, unknown> = {
      type,
      title,
      defaultLocale: lead!.locale,
      locales,
      blocks: blocks.map((b, i) => ({
        id: `wp-${post.id}-${i + 1}`,
        type: b.type,
        version: BLOCK_DEFINITIONS[b.type].version,
        props: b.props,
      })),
      ...(Object.keys(leads).length && { lead: leads }),
      ...(header.heroImageId && { heroImageId: header.heroImageId }),
      ...(Object.keys(heroAlt).length && { heroAlt }),
      ...(featuredImage && { featuredImageId: featuredImage.ref }),
      ...(Object.keys(excerpts).length && { featured: { description: excerpts } }),
    };
    if (type === 'article') {
      const author = personRef(post.creator);
      const [first, ...extra] = post.categories.filter((c) => !NO_SECTION.has(c.slug));
      for (const c of extra) report.push({ code: 'item.section-extra', ...at, detail: c.slug });
      const tags: string[] = [];
      for (const tag of post.tags)
        if (Tags.safeParse([tag.name]).success) tags.push(tag.name);
        else report.push({ code: 'item.tag-invalid', ...at, detail: tag.name });
      Object.assign(document, {
        authorIds: author ? [author] : [],
        sectionId: first ? sectionRef(first.slug) : null,
        tags,
      });
    }
    const parsed = ContentDocumentInput.safeParse(document);
    if (!parsed.success) {
      report.push({ code: 'item.invalid', ...at, detail: firstIssue(parsed.error) });
      continue;
    }
    const published = post.status === 'publish';
    items.push({
      ref: placeholder('item', post.id),
      sources: merged.map((b) => ({ id: b.post.id, locale: b.locale })),
      slug,
      status: published ? 'published' : 'draft',
      publishedAt: published ? post.dateGmt : null,
      document: document as z.input<typeof ContentDocumentInput>,
    });
  }

  return {
    site: { title: wxr.site.title, url: wxr.site.url },
    defaultLocale,
    locales: [...new Set([defaultLocale, ...items.flatMap((i) => i.document.locales)])],
    media,
    people,
    sections,
    items,
    report,
  };
}
