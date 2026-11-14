// The render model as Markdown (brief #8c § 4): the source for `llms.txt` (#9), the mail
// renderer (phase 4) and agents that read a page. It is derived from the same model as the HTML,
// so it carries the same locale, the same resolved links and nothing a restricted reference
// hid. No HTML in the output: text is escaped for Markdown, and a site-root path becomes an
// absolute URL on the site's own address (`siteRoot`, built by `siteUrl`, ADR 014 rule 6).
//
// Headings follow the same depth rules as the HTML (headings.ts). A form becomes one line with
// its submit label linking to the page itself; a paywall and a decorative image add nothing. A
// campaign card is its title linking to the campaign's page and its summary, never a form or a
// count (ADR 033 consequences); a form whose campaign is not open adds nothing.

import type { Mark, MediaCredit, RichTextDoc } from '@mycel/core';
import { creditText } from './credit.js';
import { BLOCK_DEPTH, headingTag } from './headings.js';
import {
  VIDEO_PROVIDER_NAMES,
  type RenderBlock,
  type RenderImage,
  type RenderModel,
} from './model.js';
import { linkTarget } from './rich-text.js';

export interface MarkdownOptions {
  /** The page's own absolute URL. */
  canonicalUrl: string;
  /** The site's absolute root without a trailing slash; site-root paths are appended to it. */
  siteRoot: string;
}

type Inline = { type: 'text'; text: string; marks?: Mark[] } | { type: 'hard_break' };

/** Characters with a meaning in inline Markdown, escaped so text stays text. */
const md = (s: string): string => s.replace(/([\\`*_{}[\]()<>#+!|~])/g, '\\$1');
const heading = (depth: number, text: string) =>
  `${'#'.repeat(Number(headingTag(depth).slice(1)))} ${md(text)}`;

export function renderMarkdown(model: RenderModel, options: MarkdownOptions): string {
  const abs = (href: string) => (href.startsWith('/') ? `${options.siteRoot}${href}` : href);
  const link = (label: string, href: string) => `[${md(label)}](<${abs(href)}>)`;

  const inline = (nodes: readonly Inline[] | undefined, notes: string[]): string =>
    (nodes ?? [])
      .map((n) => {
        if (n.type === 'hard_break') return '  \n';
        const marks = n.marks ?? [];
        const has = (type: Mark['type']) => marks.some((m) => m.type === type);
        let out = has('code') ? `\`${n.text.replace(/`/g, "'")}\`` : md(n.text);
        if (has('italic')) out = `*${out}*`;
        if (has('bold')) out = `**${out}**`;
        let note = '';
        for (const m of marks) {
          if (m.type === 'link') {
            const href = linkTarget(m, model.links);
            if (href !== null) out = `[${out}](<${abs(href)}>)`;
          } else if (m.type === 'footnote_reference') {
            notes.push(m.attrs.text);
            note = `[^${notes.length}]`;
          }
        }
        return out + note;
      })
      .join('');

  const richText = (doc: RichTextDoc, depth: number): string => {
    const notes: string[] = [];
    const block = (node: { type: string; [k: string]: unknown }, indent = ''): string => {
      switch (node.type) {
        case 'paragraph':
          return indent + inline(node['content'] as Inline[], notes);
        case 'heading':
          return `${'#'.repeat(Number(headingTag(depth + (node['attrs'] as { level: number }).level).slice(1)))} ${inline(node['content'] as Inline[], notes)}`;
        case 'bullet_list':
        case 'ordered_list': {
          const start = (node['attrs'] as { start?: number } | undefined)?.start ?? 1;
          return (node['content'] as { content: { type: string }[] }[])
            .map((li, i) => {
              const marker = node.type === 'bullet_list' ? '-' : `${start + i}.`;
              const [first, ...rest] = li.content;
              const pad = `${indent}${' '.repeat(marker.length + 1)}`;
              return [
                `${indent}${marker} ${block(first as { type: string }, '').trimStart()}`,
                ...rest.map((c) => block(c as { type: string }, pad)),
              ].join('\n');
            })
            .join('\n');
        }
        default:
          throw new Error(`unknown rich-text node ${node.type}`);
      }
    };
    const body = doc.content.map((n) => block(n as { type: string })).join('\n\n');
    return notes.length
      ? `${body}\n\n${notes.map((t, i) => `[^${i + 1}]: ${md(t)}`).join('\n')}`
      : body;
  };

  const credit = (c: MediaCredit) => creditText(c, model.copy.credit);

  /** One image with its caption and credit; a decorative image says nothing here. */
  const image = (i: RenderImage): string | null => {
    if (!i.alt) return null;
    const lines = [`![${md(i.alt)}](<${abs(i.src)}>)`];
    const caption = [i.caption && md(i.caption), i.credit && md(credit(i.credit))]
      .filter(Boolean)
      .join(' · ');
    if (caption) lines.push(`*${caption}*`);
    return lines.join('\n');
  };

  const out: string[] = [`# ${md(model.title)}`];
  for (const b of model.blocks) {
    const part = blockMarkdown(b);
    if (part) out.push(part);
  }
  return `${out.join('\n\n')}\n`;

  function blockMarkdown(b: RenderBlock): string | null {
    switch (b.type) {
      case 'people-grid':
        return b.people
          .map((p) =>
            [
              p.href ? link(p.name, p.href) : md(p.name),
              b.showRole && p.role ? md(p.role) : '',
              b.showBio && p.bio ? md(p.bio) : '',
              ...(b.showContact
                ? [
                    p.publicEmail ? link(p.publicEmail, `mailto:${p.publicEmail}`) : '',
                    p.phone ? link(p.phone, `tel:${p.phone}`) : '',
                    ...p.links.map((l) => link(l.label, l.url)),
                  ]
                : []),
            ]
              .filter(Boolean)
              .join('\n\n')
          )
          .join('\n\n');
      case 'heading':
        return heading(BLOCK_DEPTH, b.text);
      case 'rich-text':
        return richText(b.doc, 1);
      case 'paywall':
        return null;
      case 'image':
        return b.image ? image(b.image) : null;
      case 'gallery': {
        const images = b.images.flatMap((i) => image(i) ?? []);
        return images.length ? images.join('\n\n') : null;
      }
      case 'hero':
      case 'cta': {
        const lines = [heading(BLOCK_DEPTH, b.title)];
        if (b.type === 'hero' && b.image?.alt)
          lines.push(`![${md(b.image.alt)}](<${abs(b.image.src)}>)`);
        if (b.body) lines.push(md(b.body));
        if (b.actions.length) lines.push(b.actions.map((a) => link(a.label, a.href)).join(' · '));
        return lines.join('\n\n');
      }
      case 'cards':
        return b.cards
          .flatMap((c) => [
            heading(BLOCK_DEPTH, c.title),
            ...(c.body ? [md(c.body)] : []),
            ...c.actions.map((a) => link(a.label, a.href)),
          ])
          .join('\n\n');
      case 'file-download': {
        if (!b.files.length) return null;
        return [
          ...(b.title ? [heading(BLOCK_DEPTH, b.title)] : []),
          ...(b.body ? [md(b.body)] : []),
          b.files.map((f) => `- ${link(f.label, f.href)} (${md(f.meta)})`).join('\n'),
        ].join('\n\n');
      }
      case 'audio':
        if (!b.file) return null;
        return [
          heading(BLOCK_DEPTH, b.title),
          `${link(model.copy.audioDownload, b.file.href)} (${md(b.file.meta)})`,
          ...(b.transcript ? [md(b.transcript)] : []),
        ].join('\n\n');
      case 'timeline':
        return [
          ...(b.title ? [heading(BLOCK_DEPTH, b.title)] : []),
          ...b.events.flatMap((e) => [
            heading(b.title ? BLOCK_DEPTH + 1 : BLOCK_DEPTH, e.title),
            `*${md(e.dateLabel)}*`,
            ...(e.body ? [md(e.body)] : []),
            ...e.actions.map((a) => link(a.label, a.href)),
          ]),
        ].join('\n\n');
      case 'callout': {
        const label = `*${md(model.copy.callout[b.variant])}*`;
        const lines = b.title ? [label, heading(BLOCK_DEPTH, b.title)] : [label];
        lines.push(richText(b.body, b.title ? BLOCK_DEPTH : 1));
        return lines.join('\n\n');
      }
      case 'faq': {
        const lines = b.title ? [heading(BLOCK_DEPTH, b.title)] : [];
        const depth = b.title ? BLOCK_DEPTH + 1 : BLOCK_DEPTH;
        for (const e of b.entries)
          lines.push(heading(depth, e.question), richText(e.answer, depth));
        return lines.join('\n\n');
      }
      case 'quote': {
        const who = [md(b.name), b.role && md(b.role)].filter(Boolean).join(', ');
        const source = b.source
          ? b.url
            ? link(b.source, b.url)
            : md(b.source)
          : b.url
            ? `<${b.url}>`
            : null;
        return `> ${md(b.text)}\n>\n> *${[who, source].filter(Boolean).join(', ')}*`;
      }
      case 'video-embed': {
        const line = `${link(b.title, b.url)} (${md(model.copy.videoOn.replace('{provider}', VIDEO_PROVIDER_NAMES[b.provider]))})`;
        return b.caption ? `${line}\n\n*${md(b.caption)}*` : line;
      }
      case 'form':
        return b.form ? link(b.form.submitLabel, options.canonicalUrl) : null;
      case 'campaign-card':
        if (!b.campaign) return null;
        return [
          `${'#'.repeat(BLOCK_DEPTH)} ${link(b.campaign.title, b.campaign.href)}`,
          ...(b.campaign.summary ? [md(b.campaign.summary)] : []),
        ].join('\n\n');
      default:
        return b satisfies never;
    }
  }
}
