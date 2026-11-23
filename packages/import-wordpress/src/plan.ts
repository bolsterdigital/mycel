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
//
// A Dreamkit theme opens every article with its featured image as a cover header (MY-274), so for
// a Dreamkit export the featured image is also the article's hero, with the file's alt text and
// `presentation.header: 'cover'`. An export is a Dreamkit one when a post uses a `wings/` block.
// Rejected: making every WordPress export's featured image a header (most themes show it only on
// cards, and a header the old site did not have changes how the article reads).
//
// A Wings dossier (MY-290) is a post of type `dossier` (the landing, with intro and image) plus a
// term of taxonomy `dossier` that its members carry; the two name each other through
// `_dossier_term_id` and `_dossier_post_id`, and either side is enough. The landing becomes a page
// with the `dossier` profile, a member names it in `dossiers` (at most three, ADR 012), and
// `_hide_dossier_section` becomes `showDossier: false`. A regular category with the same name is
// a section and adds no membership. Rejected: matching a term to a landing by slug (a regular
// page or a second landing may share it, and a wrong dossier box is worse than a report line).

import { campaignBrand, type CampaignColours } from './brand.js';
import {
  BLOCK_DEFINITIONS,
  ContentDocumentInput,
  contentPath,
  Locale,
  OVERVIEW_LIMITS,
  PersonInput,
  Tags,
  isReservedPageSlug,
  type ContentType,
} from '@mycel/core';
import type { z } from 'zod';
import {
  CONTAINERS,
  decodedSlug,
  lookOf,
  mapBlock,
  slugOf,
  type BlockDraft,
  type HeaderDraft,
  type MapContext,
  type MediaRef,
  type NoteCode,
} from './blocks.js';
import {
  CAMPAIGN_TYPES,
  SOURCE_BASE,
  isCampaignType,
  planCampaign,
  type CampaignCode,
  type PlannedCampaign,
} from './campaigns.js';
import { parseBlocks, type WpBlock } from './grammar.js';
import { decodeEntities } from './markup.js';
import { linkRewriter, normalPath, plainText } from './rich.js';
import { GROUP_TAXONOMIES, readWxr, type WxrPost } from './wxr.js';

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
  /** The author's login, or for a Wings person or organisation post its post name. */
  sourceLogin: string;
  /** The Wings person or organisation post it comes from; absent for an author. */
  sourceId?: number;
  name: string;
  /** The other `PersonInput` fields of a Wings post; the image is a media placeholder. */
  profile?: Omit<z.input<typeof PersonInput>, 'name'>;
}

/** A person group made from a Wings people or organisation category (MY-281). */
export interface PlannedGroup {
  ref: string;
  sourceTermId: number;
  name: Record<string, string>;
  order: number;
  personRefs: string[];
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
  | 'block.unwrapped'
  | 'block.shortcode'
  | 'block.invalid'
  | 'block.media-missing'
  | 'block.people-missing'
  | 'block.items-missing'
  | 'person.link-invalid'
  | 'person.bio-too-long'
  | 'hero.extra'
  | 'item.invalid'
  | 'item.private'
  | 'item.scheduled'
  | 'item.slug-changed'
  | 'item.parent-flattened'
  | 'item.section-extra'
  | 'item.tag-invalid'
  | 'item.excerpt-too-long'
  | 'item.posts-page'
  | 'dossier.unlinked'
  | 'dossier.ambiguous'
  | 'dossier.extra'
  | CampaignCode
  | 'translation.not-merged'
  | 'translation.value-differs'
  // What happened while executing the plan against a tenant (execute.ts).
  | 'media.failed'
  | 'person.failed'
  | 'group.failed'
  | 'section.failed'
  | 'item.failed'
  | 'item.blocks-failed'
  | 'item.publish-failed'
  | 'campaign.failed'
  | 'theme.campaign-skipped'
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
  /** Whether an article's featured image became its cover header (`PlanOptions`). */
  featuredAsHeader: boolean;
  locales: string[];
  media: PlannedMedia[];
  people: PlannedPerson[];
  groups: PlannedGroup[];
  sections: PlannedSection[];
  items: PlannedItem[];
  campaigns: PlannedCampaign[];
  campaignColours?: CampaignColours;
  report: ReportLine[];
}

export interface PlanOptions {
  /** The site's main language; else the first Polylang language, else the channel's language. */
  defaultLocale?: string;
  /** Generated Dreamkit Wings tokens, already resolved to CSS values. */
  brandTokens?: unknown;
  /**
   * An article with a featured image gets `presentation.header: 'cover'`, with that image as its
   * hero (alt text from the file) unless its own Wings hero already set one. Absent: on for a
   * Dreamkit export (a post uses a `wings/` block), off otherwise.
   */
  featuredAsHeader?: boolean;
  /** WordPress's Reading setting and effective page size, which WXR does not export. */
  postsPage?: { sourceId: number; pageSize: number };
}

const KIND = {
  media: 1,
  person: 2,
  section: 3,
  item: 4,
  profile: 5,
  group: 6,
  campaign: 7,
} as const;

/** The placeholder guid of one source entity; valid as a guid and as a v4 uuid. */
export function placeholder(kind: keyof typeof KIND, n: number): string {
  return `00000000-0000-4000-800${KIND[kind]}-${String(n).padStart(12, '0')}`;
}

const TYPES: Record<string, ContentType> = {
  page: 'page',
  post: 'article',
  dossier: 'page',
  // A Dreamkit action's content is its campaign's landing page (MY-291, `campaigns.ts`).
  petition: 'page',
  signup: 'page',
  fundraiser: 'page',
};
/** The Wings post types that become entries of the people register (ADR 031). */
const PERSON_TYPES: Record<string, 'person' | 'organisation'> = {
  people: 'person',
  organizations: 'organisation',
};
/** Wings social fields as person links; a username field gets its network's address. */
type LinkKind = NonNullable<z.input<typeof PersonInput>['links']>[number]['kind'];
const LINKS: [meta: string, kind: LinkKind, label: string, base?: string][] = [
  ['_website_url', 'website', 'Website'],
  ['_linkedin_url', 'linkedin', 'LinkedIn'],
  ['_instagram_username', 'instagram', 'Instagram', 'https://www.instagram.com/'],
  ['_x_username', 'x', 'X', 'https://x.com/'],
  ['_facebook_url', 'facebook', 'Facebook'],
  ['_youtube_url', 'youtube', 'YouTube'],
  ['_tiktok_url', 'tiktok', 'TikTok'],
  ['_mastodon_url', 'mastodon', 'Mastodon'],
  ['_bluesky_username', 'bluesky', 'Bluesky', 'https://bsky.app/profile/'],
];
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
  const colours =
    options.brandTokens === undefined ? {} : campaignBrand(options.brandTokens, report);
  const defaultLocale = options.defaultLocale ?? wxr.site.languages[0] ?? wxr.site.language ?? 'en';
  const featuredAsHeader =
    options.featuredAsHeader ?? wxr.posts.some((p) => p.content.includes('<!-- wp:wings/'));
  const localeOf = (post: WxrPost) =>
    post.language && Locale.safeParse(post.language).success ? post.language : defaultLocale;

  const media: PlannedMedia[] = [];
  const mediaById = new Map<number, MediaRef>();
  for (const post of wxr.posts.filter((p) => p.type === 'attachment' && p.attachmentUrl)) {
    const url = post.attachmentUrl!;
    const filename = decodeURIComponent(url.split('/').pop() ?? '') || `${post.id}`;
    const alt = decodeEntities(post.meta._wp_attachment_image_alt ?? '').trim() || null;
    const ref = placeholder('media', post.id);
    media.push({ ref, sourceId: post.id, url, filename, title: post.title || filename, alt });
    mediaById.set(post.id, { ref, alt, title: post.title || filename });
  }
  const mediaRef = (id: unknown) => mediaById.get(Number(id)) ?? null;

  // Which posts become items, grouped by translation; the leader is the default language.
  const content = wxr.posts.filter((p) => TYPES[p.type] && !SKIPPED_STATUS.has(p.status));
  const postsPage = options.postsPage;
  const pageSize = String(postsPage?.pageSize);
  if (postsPage && !OVERVIEW_LIMITS.includes(pageSize))
    throw new Error(`Posts page size must be an integer from 1 to ${OVERVIEW_LIMITS.length}`);
  if (
    postsPage &&
    !content.some((p) => p.id === postsPage.sourceId && p.type === 'page' && p.status === 'publish')
  )
    throw new Error(`Posts page ${postsPage.sourceId} is not a published page in the export`);
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
  const postsPageGroup = postsPage
    ? [...groups.values()].find((members) => members.some((p) => p.id === postsPage.sourceId))
    : undefined;
  const itemOf = new Map<number, string>();
  const itemAtPath = new Map<string, string>();
  /** The campaign a Dreamkit action becomes, by the id of any of its translations (MY-291). */
  const campaignOf = new Map<number, string>();
  for (const members of groups.values())
    for (const post of members) {
      const ref = placeholder('item', members[0]!.id);
      itemOf.set(post.id, ref);
      if (isCampaignType(post.type))
        campaignOf.set(post.id, placeholder('campaign', members[0]!.id));
      try {
        if (post.link) itemAtPath.set(normalPath(new URL(post.link).pathname), ref);
      } catch {
        // A post without a valid address is only reachable by id.
      }
    }
  const link = linkRewriter(wxr.site.url, (path) => itemAtPath.get(path) ?? null);

  // Wings dossiers (MY-290): which landing each dossier term leads to, by term id. A term that two
  // landings claim leads nowhere; its members get a report line, not a guess.
  const landings = new Map<number, Set<string>>();
  const claim = (termId: number, postId: number) => {
    const ref = itemOf.get(postId);
    const post = content.find((p) => p.id === postId);
    if (!termId || !ref || post?.type !== 'dossier') return;
    landings.set(termId, (landings.get(termId) ?? new Set()).add(ref));
  };
  for (const post of content.filter((p) => p.type === 'dossier'))
    claim(Number(post.meta._dossier_term_id), post.id);
  const dossierTerms = wxr.terms.filter((t) => t.taxonomy === 'dossier');
  for (const term of dossierTerms) claim(term.id, Number(term.meta._dossier_post_id));
  const landingOf = (termId: number) => {
    const refs = [...(landings.get(termId) ?? [])];
    return refs.length === 1 ? refs[0]! : null;
  };
  /** The dossiers a post belongs to, at most three; what does not come over is reported. */
  const dossiersOf = (post: WxrPost, at: Omit<ReportLine, 'code'>) => {
    const refs: string[] = [];
    for (const named of post.dossiers) {
      const term = dossierTerms.find((t) => t.slug === named.slug);
      const claims = term ? (landings.get(term.id)?.size ?? 0) : 0;
      const ref = term ? landingOf(term.id) : null;
      if (claims > 1)
        report.push({
          code: 'dossier.ambiguous',
          ...at,
          detail: `${named.name}: ${claims} landing pages`,
        });
      else if (!ref) report.push({ code: 'dossier.unlinked', ...at, detail: named.name });
      else if (post.type === 'dossier')
        report.push({ code: 'dossier.extra', ...at, detail: `${named.name} (on a dossier page)` });
      else if (refs.length >= 3) report.push({ code: 'dossier.extra', ...at, detail: named.name });
      else if (!refs.includes(ref)) refs.push(ref);
    }
    return refs;
  };

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

  // Wings people and organisations (MY-281): one register entry per published post, with the
  // card's fields. Their e-mail address and phone number are left behind: a Wings card never
  // showed them, and an address that is not imported cannot leak (ADR 019 rule 7).
  const personOf = new Map<number, string>();
  const byTitle = (a: WxrPost, b: WxrPost) => a.title.localeCompare(b.title, defaultLocale);
  const profiles = wxr.posts
    .filter((p) => PERSON_TYPES[p.type] && p.status === 'publish')
    .sort(byTitle);
  for (const post of profiles) {
    const kind = PERSON_TYPES[post.type]!;
    const locale = localeOf(post);
    const at = { postId: post.id, title: post.title, locale };
    const meta = (key: string) => decodeEntities(post.meta[key] ?? '').trim();
    const links = [];
    for (const [key, linkKind, label, base] of LINKS) {
      const value = meta(key).replace(/^@/, '');
      if (!value) continue;
      const link = {
        label,
        kind: linkKind,
        url: base && !/^https?:/i.test(value) ? base + value : value,
      };
      if (PersonInput.safeParse({ name: 'x', links: [link] }).success) links.push(link);
      else report.push({ code: 'person.link-invalid', ...at, detail: `${key}: ${value}` });
    }
    const bio = meta('_description');
    if (bio.length > 5000) report.push({ code: 'person.bio-too-long', ...at });
    const role = meta('_function_title');
    const organisation = meta('_organization_name');
    const image = mediaRef(post.meta._thumbnail_id);
    const ref = placeholder('profile', post.id);
    personOf.set(post.id, ref);
    people.push({
      ref,
      sourceLogin: post.slug,
      sourceId: post.id,
      name: post.title,
      profile: {
        kind,
        ...(bio && bio.length <= 5000 && { bio: { [locale]: bio } }),
        ...(role && kind === 'person' && { role: { [locale]: role } }),
        ...(organisation && { organisation: organisation.slice(0, 200) }),
        ...(image && { imageId: image.ref }),
        links: links.slice(0, 10),
      },
    });
  }
  // A Wings category of people becomes a group, its members in the order Wings shows them.
  const personGroups: PlannedGroup[] = [];
  const groupOf = new Map<number, string>();
  for (const term of wxr.terms.filter((t) => GROUP_TAXONOMIES.includes(t.taxonomy))) {
    const members = profiles.filter((p) =>
      p.groups.some((g) => g.taxonomy === term.taxonomy && g.slug === term.slug)
    );
    if (!members.length) continue;
    const ref = placeholder('group', term.id);
    groupOf.set(term.id, ref);
    personGroups.push({
      ref,
      sourceTermId: term.id,
      name: { [defaultLocale]: term.name },
      order: personGroups.length,
      personRefs: members.map((p) => personOf.get(p.id)!),
    });
  }
  const everyone = (kind: 'person' | 'organisation') =>
    profiles.filter((p) => PERSON_TYPES[p.type] === kind).map((p) => personOf.get(p.id)!);

  // Old Wings ids of migrated posts, as a Dreamkit grid without `selectedNodes` names them.
  const byWingsId = new Map<string, number>();
  for (const post of wxr.posts)
    for (const key of ['_wings_original_id', '_wings_original_campaign_id'])
      if (post.meta[key]) byWingsId.set(post.meta[key]!, post.id);

  const build = (post: WxrPost): Built => {
    const locale = localeOf(post);
    const lines: ReportLine[] = [];
    const at = { postId: post.id, title: post.title, locale };
    // WordPress's posts-page template uses the main query and ignores the stored page body.
    // Import that visible archive, not the stale blocks that happen to be in its WXR item.
    if (postsPageGroup?.includes(post)) {
      return {
        post,
        locale,
        blocks: [
          {
            type: 'overview',
            props: { source: 'article', order: 'newest', limit: pageSize, archive: true },
          },
        ],
        header: {},
        lines: [{ code: 'item.posts-page', ...at, detail: `${pageSize} articles per page` }],
      };
    }
    const drafts: BlockDraft[] = [];
    let header: HeaderDraft | null = null;
    // A layout container is unwrapped: its inner blocks take its place, and their report lines
    // keep the container's top-level position (MY-282).
    const visit = (block: WpBlock, position: number): void => {
      if (block.name && CONTAINERS.has(block.name)) {
        const look = lookOf(block);
        if (look)
          lines.push({ code: 'block.unwrapped', ...at, block: block.name, position, detail: look });
        for (const inner of block.innerBlocks) visit(inner, position);
        return;
      }
      mapOne(block, position);
    };
    const mapOne = (block: WpBlock, position: number) => {
      const where = { ...at, block: block.name ?? 'freeform', position };
      const ctx: MapContext = {
        locale,
        // Nothing placed yet: a block left out before the hero does not show on the old page.
        opensPage: TYPES[post.type] === 'page' && !drafts.length && !header,
        postTitle: post.title,
        link,
        media: mediaRef,
        item: (id) => itemOf.get(Number(id)) ?? null,
        person: (id) => personOf.get(Number(id)) ?? null,
        personGroup: (id) => groupOf.get(Number(id)) ?? null,
        everyone,
        wingsNode: (id) => {
          const post = byWingsId.get(String(id));
          return post === undefined ? null : (itemOf.get(post) ?? null);
        },
        dossier: (termId) => landingOf(Number(termId)),
        campaign: (postId) => campaignOf.get(Number(postId)) ?? null,
        section: (termId) => {
          const term = wxr.terms.find((t) => t.taxonomy === 'category' && t.id === Number(termId));
          return term ? sectionRef(term.slug) : null;
        },
        note: (code, detail) => lines.push({ code, ...where, ...(detail && { detail }) }),
      };
      const mapped = mapBlock(block, ctx);
      if (mapped.kind === 'skip') {
        if (mapped.reason === 'empty') return;
        const code = {
          unsupported: 'block.skipped',
          shortcode: 'block.shortcode',
          'media-missing': 'block.media-missing',
          'people-missing': 'block.people-missing',
          'items-missing': 'block.items-missing',
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
    };
    parseBlocks(post.content).forEach((block, i) => visit(block, i + 1));
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
  const campaigns: PlannedCampaign[] = [];
  const slugs = new Set<string>();
  for (const members of groups.values()) {
    const [lead, ...rest] = members.map(build);
    const post = lead!.post;
    const type = TYPES[post.type]!;
    const at = { postId: post.id, title: post.title, locale: lead!.locale };
    report.push(...lead!.lines);

    const header = { ...lead!.header };
    const title: Record<string, string> = {
      [lead!.locale]: header.split?.title || post.title,
    };
    const actionLabels: Record<string, string> = header.split?.action
      ? { [lead!.locale]: header.split.action.label }
      : {};
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
        Boolean(other.header.heroImageId) === Boolean(header.heroImageId) &&
        Boolean(other.header.split) === Boolean(header.split) &&
        Boolean(other.header.split?.action) === Boolean(header.split?.action);
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
      const [to, otherTo] = [header.split?.action?.target, other.header.split?.action?.target];
      if (JSON.stringify(to) !== JSON.stringify(otherTo)) conflicts.push('presentation.action');
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
      title[other.locale] = other.header.split?.title || other.post.title;
      if (other.header.split?.action) actionLabels[other.locale] = other.header.split.action.label;
      if (other.header.lead) leads[other.locale] = other.header.lead;
      if (other.header.heroAlt) heroAlt[other.locale] = other.header.heroAlt;
      excerptOf(other);
    }

    let slug = slugOf(post.slug, post.title) || `${type}-${post.id}`;
    const original = slug;
    if (type === 'page' && isReservedPageSlug(slug)) slug = `${slug}-page`;
    for (let n = 2; slugs.has(`${type}:${slug}`); n++) slug = `${original}-${n}`;
    slugs.add(`${type}:${slug}`);
    // The old address next to the new one, so a redirect list can be made from the report.
    // A Wings dossier lived under `/dossiers/` and an action under its kind's base, so their
    // address changes even with the same slug.
    const moved = post.type === 'dossier' || isCampaignType(post.type);
    if (post.slug && (slug !== decodedSlug(post.slug) || moved))
      report.push({
        code: 'item.slug-changed',
        ...at,
        detail: `${post.link || post.slug} → ${contentPath({ type, slug }, lead!.locale, defaultLocale)}`,
      });
    if (post.parent) report.push({ code: 'item.parent-flattened', ...at });
    if (post.status === 'private') report.push({ code: 'item.private', ...at });
    if (post.status === 'future')
      report.push({ code: 'item.scheduled', ...at, detail: post.dateGmt ?? '' });

    // A Dreamkit action shows its header image, else its featured image (`milestone-functions.php`).
    const featuredImage =
      (isCampaignType(post.type) && mediaRef(post.meta._campaign_header_image)) ||
      mediaRef(post.meta._thumbnail_id);
    const cover = featuredAsHeader && type === 'article' && Boolean(featuredImage);
    if (cover && !header.heroImageId) {
      header.heroImageId = featuredImage!.ref;
      if (featuredImage!.alt) for (const l of locales) heroAlt[l] = featuredImage!.alt;
    }
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
      ...(post.type === 'dossier' && { profile: 'dossier' }),
      ...(header.split &&
        header.heroImageId && {
          presentation: {
            header: 'split',
            ...(header.split.action && {
              action: { label: actionLabels, target: header.split.action.target },
            }),
          },
        }),
    };
    const dossiers = dossiersOf(post, at);
    if (dossiers.length) document.dossiers = dossiers.map((itemId) => ({ itemId }));
    if (dossiers.length && post.meta._hide_dossier_section === '1') document.showDossier = false;
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
        ...(cover && { presentation: { header: 'cover' } }),
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
    if (isCampaignType(post.type)) {
      const planned = planCampaign(post, post.type, {
        ref: campaignOf.get(post.id)!,
        landingRef: placeholder('item', post.id),
      });
      campaigns.push(planned.campaign);
      for (const line of planned.lines) report.push({ ...at, ...line });
    }
  }
  // Dreamkit's archives of each kind go to the index of that kind (ADR 033, amendment 2026-11-23).
  for (const kind of CAMPAIGN_TYPES)
    if (campaigns.some((c) => c.kind === kind))
      report.push({
        code: 'campaign.archive',
        detail: `${wxr.site.url.replace(/\/$/, '')}/${SOURCE_BASE[kind]}/ → the page with the index of ${kind}s`,
      });

  return {
    site: { title: wxr.site.title, url: wxr.site.url },
    defaultLocale,
    featuredAsHeader,
    locales: [...new Set([defaultLocale, ...items.flatMap((i) => i.document.locales)])],
    media,
    people,
    groups: personGroups,
    sections,
    items,
    campaigns,
    ...(Object.keys(colours).length && { campaignColours: colours }),
    report,
  };
}
