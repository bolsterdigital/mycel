// Rich text (ADR 020 rule 2) to HTML: the constrained ProseMirror JSON the core validated, walked
// once into escaped markup that `RichText.svelte` places with `{@html}`. A string renderer
// instead of one recursive component per node, because the footnotes need one pass that numbers
// the references and collects their notes, and because Markdown walks the same tree
// (markdown.ts). Every text and attribute goes through `escape`; there is no path by which
// document content becomes markup.
//
// Links: an `itemId` link becomes an `<a>` only when the resolver gave the item a public path in
// this locale (`links`), otherwise plain text; an `href` was checked by `isSafeHref` on write and
// is escaped here regardless. An unknown node or mark throws: the projection is validated, so
// one here is a bug, not input to tolerate.
//
// `inert` is the same walk for a block at rest on the edit screen (MY-110 C1): no link that leaves
// the unsaved form and no heading in the admin's outline, each marked `data-*` instead so the
// screen can style it. Rejected: a second walker in the admin, which a new mark would miss.

import type { Mark, RichTextDoc } from '@mycel/core';
import { headingTag } from './headings.js';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text or attribute value as HTML. */
export const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** A site-root path gets the address-form prefix; anything else is left as it is. */
export const withBase = (base: string, href: string): string =>
  href.startsWith('/') ? `${base}${href}` : href;

export interface RichTextContext {
  /** The heading depth this text sits under: 1 for a top-level block (under the document h1). */
  depth: number;
  links: Record<string, string | null>;
  base: string;
  /** Unique per rendered document; footnote ids are `fn-<idPrefix>-<n>`. */
  idPrefix: string;
  footnotes: string;
  footnoteBack: string;
  /** No `<a>`, no heading element and no footnote ids: see the top of this file. */
  inert?: boolean;
}

type Node = RichTextDoc['content'][number] | { type: string; [k: string]: unknown };
type Inline = { type: 'text'; text: string; marks?: Mark[] } | { type: 'hard_break' };

/** The target of a link mark, or null when it is an item without a public path here. */
export function linkTarget(
  mark: Extract<Mark, { type: 'link' }>,
  links: Record<string, string | null>
): string | null {
  if (mark.attrs.itemId !== undefined) return links[mark.attrs.itemId] ?? null;
  return mark.attrs.href ?? null;
}

export function richTextHtml(doc: RichTextDoc, ctx: RichTextContext): string {
  const notes: string[] = [];

  const inline = (nodes: readonly Inline[] | undefined): string =>
    (nodes ?? [])
      .map((n) => {
        if (n.type === 'hard_break') return '<br>';
        if (n.type !== 'text') throw new Error(`unknown inline node ${(n as Node).type}`);
        let out = escape(n.text);
        let note = '';
        // Inner to outer: code, emphasis, strong, then the link around all of them.
        const marks = n.marks ?? [];
        for (const type of ['code', 'italic', 'bold'] as const)
          if (marks.some((m) => m.type === type)) out = `<${TAG[type]}>${out}</${TAG[type]}>`;
        for (const m of marks) {
          if (m.type === 'link' && ctx.inert) {
            out = `<span data-link>${out}</span>`;
          } else if (m.type === 'link') {
            const href = linkTarget(m, ctx.links);
            if (href !== null) out = `<a href="${escape(withBase(ctx.base, href))}">${out}</a>`;
          } else if (m.type === 'footnote_reference') {
            notes.push(m.attrs.text);
            const n = notes.length;
            const id = `${ctx.idPrefix}-${n}`;
            note = ctx.inert
              ? `<sup>${n}</sup>`
              : `<sup><a href="#fn-${id}" id="fnref-${id}">${n}</a></sup>`;
          } else if (!(m.type in TAG)) throw new Error(`unknown mark ${(m as Mark).type}`);
        }
        return out + note;
      })
      .join('');

  const block = (node: Node): string => {
    switch (node.type) {
      case 'paragraph':
        return `<p>${inline((node as { content?: Inline[] }).content)}</p>`;
      case 'heading': {
        const n = node as { attrs: { level: number }; content?: Inline[] };
        if (ctx.inert) return `<p data-heading="${n.attrs.level}">${inline(n.content)}</p>`;
        const tag = headingTag(ctx.depth + n.attrs.level);
        return `<${tag}>${inline(n.content)}</${tag}>`;
      }
      case 'bullet_list':
      case 'ordered_list': {
        const n = node as { attrs?: { start: number }; content: { content: Node[] }[] };
        const tag = node.type === 'bullet_list' ? 'ul' : 'ol';
        const start =
          n.attrs?.start !== undefined && n.attrs.start !== 1 ? ` start="${n.attrs.start}"` : '';
        const items = n.content.map((li) => `<li>${li.content.map(block).join('')}</li>`).join('');
        return `<${tag}${start}>${items}</${tag}>`;
      }
      default:
        throw new Error(`unknown rich-text node ${node.type}`);
    }
  };

  const body = doc.content.map(block).join('');
  if (!notes.length) return body;
  if (ctx.inert)
    return `${body}<ol data-notes>${notes.map((text) => `<li>${escape(text)}</li>`).join('')}</ol>`;
  const list = notes
    .map((text, i) => {
      const id = `${ctx.idPrefix}-${i + 1}`;
      return `<li id="fn-${id}">${escape(text)} <a href="#fnref-${id}" aria-label="${escape(ctx.footnoteBack)}">↩</a></li>`;
    })
    .join('');
  return `${body}<div class="footnotes"><p class="footnotes-label">${escape(ctx.footnotes)}</p><ol>${list}</ol></div>`;
}

const TAG = { code: 'code', italic: 'em', bold: 'strong' } as const;
