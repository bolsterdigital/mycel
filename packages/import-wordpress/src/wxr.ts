// Read a WordPress eXtended RSS export (`wp export`, Tools → Export) into plain records: the site,
// its authors, terms, posts and attachments. Only what the importer maps is read; author e-mail
// addresses are left behind on purpose, because a person's public profile does not need them and
// an address that is not imported cannot leak (ADR 019 rule 7).
// Polylang writes a post's language and its translation group as taxonomy terms on the item
// (`<category domain="language">`, `domain="post_translations"`), so both are read from the item
// itself; the serialised PHP array in the term description is not needed. Rejected: reading the
// live REST API (rendered HTML only, a key per site) and the WordPress database (network access
// and every plugin's schema), brief wordpress-import-execution § Ontwerpkeuzes 1.

import {
  childElements,
  decodeEntities,
  find,
  parseMarkup,
  textOf,
  type Element,
} from './markup.js';

export interface WxrSite {
  title: string;
  /** The site's address (`wp:base_blog_url`, else `<link>`); links to it become site paths. */
  url: string;
  /** The Polylang languages declared in the export, in the order of their terms. */
  languages: string[];
  /** The channel's `<language>` (`nl-NL` → `nl`), for an export without Polylang. */
  language: string | null;
}

export interface WxrAuthor {
  login: string;
  displayName: string;
}

export interface WxrTerm {
  slug: string;
  name: string;
}

export interface WxrPost {
  id: number;
  type: string;
  title: string;
  /** The post's public address in the old site (`<link>`). */
  link: string;
  slug: string;
  status: string;
  parent: number;
  /** `wp:post_date_gmt` as an ISO instant; null when WordPress wrote its zero date. */
  dateGmt: string | null;
  creator: string;
  content: string;
  excerpt: string;
  attachmentUrl: string | null;
  categories: WxrTerm[];
  tags: WxrTerm[];
  language: string | null;
  translationGroup: string | null;
  meta: Record<string, string>;
}

export interface WxrExport {
  site: WxrSite;
  authors: WxrAuthor[];
  categories: WxrTerm[];
  posts: WxrPost[];
}

// WordPress stores term names and post titles HTML-escaped (`Acties &amp; campagnes`) and writes
// them so into the CDATA of the export; they are decoded once more where they are read.
const field = (parent: Element, name: string) => {
  const element = find(parent, name);
  return element ? textOf(element).trim() : '';
};

function gmt(value: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value);
  if (!m || m[1] === '0000-00-00') return null;
  return `${m[1]}T${m[2]}Z`;
}

function readPost(item: Element): WxrPost {
  const terms = childElements(item, 'category');
  const ofDomain = (domain: string) =>
    terms
      .filter((t) => t.attrs.domain === domain)
      .map((t) => ({ slug: t.attrs.nicename ?? '', name: decodeEntities(textOf(t).trim()) }));
  const meta: Record<string, string> = {};
  for (const entry of childElements(item, 'wp:postmeta'))
    meta[field(entry, 'wp:meta_key')] = textOf(find(entry, 'wp:meta_value') ?? '');
  return {
    id: Number(field(item, 'wp:post_id')),
    type: field(item, 'wp:post_type'),
    // WordPress stores a title HTML-escaped (`Feiten &amp; cijfers`), as it does a term name.
    title: decodeEntities(field(item, 'title')),
    link: field(item, 'link'),
    slug: field(item, 'wp:post_name'),
    status: field(item, 'wp:status'),
    parent: Number(field(item, 'wp:post_parent') || 0),
    dateGmt: gmt(field(item, 'wp:post_date_gmt')),
    creator: field(item, 'dc:creator'),
    content: textOf(find(item, 'content:encoded') ?? ''),
    excerpt: field(item, 'excerpt:encoded'),
    attachmentUrl: field(item, 'wp:attachment_url') || null,
    categories: ofDomain('category'),
    tags: ofDomain('post_tag'),
    language: ofDomain('language')[0]?.slug ?? null,
    translationGroup: ofDomain('post_translations')[0]?.slug ?? null,
    meta,
  };
}

/** Parse a WXR document; throws when it has no `<channel>`, so a wrong file fails loudly. */
export function readWxr(xml: string): WxrExport {
  const channel = find(parseMarkup(xml, 'xml'), 'channel');
  if (!channel) throw new Error('not a WordPress export: no <channel> element');
  const languages = childElements(channel, 'wp:term')
    .filter((t) => field(t, 'wp:term_taxonomy') === 'language')
    .map((t) => field(t, 'wp:term_slug'));
  return {
    site: {
      title: field(channel, 'title'),
      url: (field(channel, 'wp:base_blog_url') || field(channel, 'link')).replace(/\/+$/, ''),
      languages,
      language: field(channel, 'language').split('-')[0]?.toLowerCase() || null,
    },
    authors: childElements(channel, 'wp:author').map((a) => ({
      login: field(a, 'wp:author_login'),
      displayName: field(a, 'wp:author_display_name') || field(a, 'wp:author_login'),
    })),
    categories: childElements(channel, 'wp:category').map((c) => ({
      slug: field(c, 'wp:category_nicename'),
      name: decodeEntities(field(c, 'wp:cat_name')),
    })),
    posts: childElements(channel, 'item').map(readPost),
  };
}
