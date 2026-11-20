// HTML from the block editor to Mycel's constrained rich text (ADR 020 rule 2) and to plain text.
// Only what the vocabulary has survives: bold, italic, code, links and line breaks inline;
// paragraphs, relative headings and lists of at most three levels as blocks. Any other inline
// element keeps its text and loses its formatting (brief wordpress-import-execution § 5), and a
// link the core would refuse keeps its text without the link. Rejected: storing the HTML
// (every renderer and agent would parse markup again) and mapping a `<span style>` to a mark the
// vocabulary does not have.

import { RICH_TEXT_LIMITS, isSafeHref, type Mark, type RichTextDoc } from '@mycel/core';
import { isElement, parseMarkup, type Element, type Node } from './markup.js';

type Inline = { type: 'text'; text: string; marks?: Mark[] } | { type: 'hard_break' };
type Paragraph = { type: 'paragraph'; content?: Inline[] };
type TopLevel = RichTextDoc['content'][number];
type ListNode = Extract<TopLevel, { type: 'bullet_list' | 'ordered_list' }>;
type ListItem = ListNode['content'][number];

/** A link as the document stores it: an item of the export by id, or a safe href. */
export type LinkTarget = { itemId: string } | { href: string };
/** Turns a link target into what the document stores, or null to keep only the text. */
export type LinkRewrite = (href: string) => LinkTarget | null;

const MARKS: Record<string, Mark> = {
  strong: { type: 'bold' },
  b: { type: 'bold' },
  em: { type: 'italic' },
  i: { type: 'italic' },
  code: { type: 'code' },
};
const BLOCK = new Set(['p', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'figure']);
const sameMarks = (a?: Mark[], b?: Mark[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

function inline(nodes: Node[], link: LinkRewrite, marks: Mark[] = []): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    if (typeof node === 'string') {
      const text = node.replace(/\s+/g, ' ');
      if (text) out.push({ type: 'text', text, ...(marks.length && { marks }) });
      continue;
    }
    if (node.name === 'br') {
      out.push({ type: 'hard_break' });
      continue;
    }
    let mark: Mark | undefined = MARKS[node.name];
    if (node.name === 'a' && node.attrs.href) {
      const to = link(node.attrs.href);
      if (to) mark = { type: 'link', attrs: to };
    }
    const next = mark && !marks.some((m) => m.type === mark.type) ? [...marks, mark] : marks;
    out.push(...inline(node.children, link, next));
  }
  return tidy(out);
}

/** Merge neighbouring text with the same marks, trim the ends, drop breaks at the edges. */
function tidy(nodes: Inline[]): Inline[] {
  const merged: Inline[] = [];
  for (const node of nodes) {
    const prev = merged[merged.length - 1];
    if (node.type === 'text' && prev?.type === 'text' && sameMarks(prev.marks, node.marks))
      prev.text += node.text;
    else merged.push(node.type === 'text' ? { ...node } : node);
  }
  while (merged[0]?.type === 'hard_break') merged.shift();
  while (merged[merged.length - 1]?.type === 'hard_break') merged.pop();
  const first = merged[0];
  if (first?.type === 'text') first.text = first.text.replace(/^\s+/, '');
  const last = merged[merged.length - 1];
  if (last?.type === 'text') last.text = last.text.replace(/\s+$/, '');
  return merged.filter((n) => n.type !== 'text' || n.text.length > 0);
}

const paragraph = (content: Inline[]): Paragraph =>
  content.length ? { type: 'paragraph', content } : { type: 'paragraph' };

function list(element: Element, link: LinkRewrite, depth: number): ListNode | null {
  const items: ListItem[] = [];
  for (const li of element.children.filter(isElement).filter((c) => c.name === 'li')) {
    const own = li.children.filter((c) => !(isElement(c) && (c.name === 'ul' || c.name === 'ol')));
    const content: ListItem['content'] = [paragraph(inline(own, link))];
    for (const sub of li.children.filter(isElement)) {
      if (sub.name !== 'ul' && sub.name !== 'ol') continue;
      // Deeper than the vocabulary allows: the items become paragraphs of this one.
      if (depth >= RICH_TEXT_LIMITS.listNesting)
        for (const deeper of sub.children.filter(isElement))
          content.push(paragraph(inline(deeper.children, link)));
      else {
        const nested = list(sub, link, depth + 1);
        if (nested) content.push(nested);
      }
    }
    items.push({ type: 'list_item', content } as ListItem);
  }
  if (!items.length) return null;
  if (element.name === 'ol') {
    const start = Number(element.attrs.start);
    return {
      type: 'ordered_list',
      ...(Number.isInteger(start) && start > 1 && { attrs: { start } }),
      content: items,
    } as ListNode;
  }
  return { type: 'bullet_list', content: items } as ListNode;
}

/** Block-level HTML to rich text; null when nothing with words remains. */
export function docFromHtml(html: string, link: LinkRewrite): RichTextDoc | null {
  const content: TopLevel[] = [];
  let loose: Node[] = [];
  let level = 0;
  const flush = () => {
    const p = inline(loose, link);
    if (p.length) content.push(paragraph(p));
    loose = [];
  };
  const visit = (nodes: Node[]) => {
    for (const node of nodes) {
      if (!isElement(node) || !BLOCK.has(node.name)) {
        loose.push(node);
        continue;
      }
      flush();
      if (node.name === 'p') {
        const p = inline(node.children, link);
        if (p.length) content.push(paragraph(p));
      } else if (node.name === 'ul' || node.name === 'ol') {
        const l = list(node, link, 1);
        if (l) content.push(l);
      } else if (/^h[1-6]$/.test(node.name)) {
        const text = inline(node.children, link);
        // h2 is a section of the document; a deeper heading never skips a level.
        const wanted = Math.max(1, Math.min(3, Number(node.name[1]) - 1));
        level = Math.min(wanted, level + 1);
        if (text.length)
          content.push({ type: 'heading', attrs: { level: level as 1 | 2 | 3 }, content: text });
      } else visit(node.children);
    }
  };
  visit(parseMarkup(html, 'html').children);
  flush();
  return content.length ? ({ type: 'doc', content } as RichTextDoc) : null;
}

/** The words of some HTML: breaks and paragraph ends as newlines, other whitespace collapsed. */
export function plainText(html: string): string {
  const parts: string[] = [];
  const visit = (nodes: Node[]) => {
    for (const node of nodes) {
      if (typeof node === 'string') parts.push(node.replace(/\s+/g, ' '));
      else if (node.name === 'br') parts.push('\n');
      else {
        visit(node.children);
        if (BLOCK.has(node.name) || node.name === 'li') parts.push('\n\n');
      }
    }
  };
  visit(parseMarkup(html, 'html').children);
  return parts
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Link targets as the core stores them. A link into the old site that names a post of the export
 * becomes that item's id, so it survives a slug change (rich-text.ts); any other link into the old
 * site becomes a site path; uploads keep their address, since the file moves with PR 2's media.
 */
export function linkRewriter(
  siteUrl: string,
  itemAt: (path: string) => string | null
): LinkRewrite {
  let site: URL | null;
  try {
    site = new URL(siteUrl);
  } catch {
    site = null;
  }
  return (raw) => {
    const href = raw.trim();
    if (site && /^https?:\/\//i.test(href)) {
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        return null;
      }
      if (url.host === site.host && !url.pathname.includes('/wp-content/')) {
        const itemId = url.search ? null : itemAt(normalPath(url.pathname));
        if (itemId) return { itemId };
        return { href: `${url.pathname}${url.search}${url.hash}` };
      }
    }
    if (href.startsWith('/') && !href.startsWith('//')) {
      const itemId = itemAt(normalPath(href.replace(/[?#].*$/, '')));
      if (itemId) return { itemId };
    }
    return isSafeHref(href) ? { href } : null;
  };
}

/** A path compared without its trailing slash: `/over-ons/` and `/over-ons` are one page. */
export const normalPath = (path: string) => path.replace(/\/+$/, '') || '/';

/** Whether a paragraph's text is nothing but a shortcode, `[gallery ids="1,2"]`. */
export const isShortcode = (text: string) =>
  /^\[[a-z][\w-]*(\s[^\]]*)?\](.*\[\/[a-z][\w-]*\])?$/is.test(text.trim());
