// The first `EmailRenderer` (ADR 004 rule 2, ADR 010 rule 6): an item's mail model as table HTML
// with inline styles and a plain-text part. Pure: no I/O, no framework, no dependency beyond the
// core's types. What a block becomes is the core's decision (`emailDocument`); this file only
// decides markup.
//
// Mail clients are not browsers: Outlook for Windows renders with Word, Gmail strips `<style>`
// in places, so layout is nested `role="presentation"` tables, every style is inline, widths are
// attributes as well as styles, and buttons are padded links, not `<button>`. One column of 600
// px that shrinks to the screen (`width:100%; max-width:600px`) needs no media query. Colours are
// the site's light palette, whose contrast `site.theme.update` already checked.
//
// Rejected: MJML or React Email (a build step and dependencies for markup this size), and a
// `<style>` block with classes (stripped by several clients, and the text must survive without it).

import type {
  EmailAction,
  EmailBlock,
  EmailDocument,
  EmailImage,
  EmailRenderer,
  EmailTone,
  Mark,
  RenderedEmail,
  RichTextDoc,
} from '@mycel/core';

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',Times,serif";
const MONO = "ui-monospace,Menlo,Consolas,'Courier New',monospace";
const WIDTH = 600;
const GUTTER = 24;

export const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

type Inline = { type: 'text'; text: string; marks?: Mark[] } | { type: 'hard_break' };
type RichNode = { type: string; attrs?: Record<string, unknown>; content?: RichNode[] };

export function createEmailRenderer(): EmailRenderer {
  return { render: renderEmail };
}

export function renderEmail(email: EmailDocument): RenderedEmail {
  return { html: renderHtml(email), text: renderText(email) };
}

/** An absolute http(s), mailto or tel link, or null: anything else is shown as text. */
function hrefOf(href: string, siteUrl: string): string | null {
  const full = href.startsWith('/') ? `${siteUrl}${href}` : href;
  return /^(https?:\/\/|mailto:|tel:)/i.test(full) ? full : null;
}

/** A rich-text link mark's target, or null when it points at an item that is not public. */
function linkOf(mark: Extract<Mark, { type: 'link' }>, email: EmailDocument): string | null {
  if (mark.attrs.itemId !== undefined) return email.links[mark.attrs.itemId] ?? null;
  return mark.attrs.href ? hrefOf(mark.attrs.href, email.site.url) : null;
}

// --- HTML ---------------------------------------------------------------------------------------

function renderHtml(email: EmailDocument): string {
  const { theme } = email;
  const head = theme.headingFont === 'serif' ? SERIF : SANS;
  const link = (href: string, label: string, extra = '') =>
    `<a href="${esc(href)}" style="color:${theme.link};text-decoration:underline;${extra}">${label}</a>`;
  const heading = (tag: 'h1' | 'h2' | 'h3' | 'h4', html: string, size: number, margin: string) =>
    `<${tag} style="margin:${margin};font-family:${head};font-size:${size}px;line-height:1.25;font-weight:700;">${html}</${tag}>`;
  const row = (html: string, pad = `0 ${GUTTER}px 20px`) =>
    `<tr><td style="padding:${pad};">${html}</td></tr>`;
  const box = (tone: EmailTone, html: string, border = '') =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${tone.background};color:${tone.foreground};${border}"><tr><td style="padding:20px;">${html}</td></tr></table>`;
  const button = (a: EmailAction) =>
    `<a href="${esc(a.href)}" style="display:inline-block;margin:8px 8px 0 0;padding:12px 20px;background-color:${theme.primary.background};color:${theme.primary.foreground};font-weight:700;text-decoration:none;border-radius:4px;">${esc(a.label)}</a>`;

  const inline = (nodes: readonly Inline[] | undefined, notes: string[], color: string) =>
    (nodes ?? [])
      .map((n) => {
        if (n.type === 'hard_break') return '<br>';
        const marks = n.marks ?? [];
        let out = esc(n.text);
        for (const m of marks) {
          if (m.type === 'bold') out = `<strong>${out}</strong>`;
          else if (m.type === 'italic') out = `<em>${out}</em>`;
          else if (m.type === 'code') out = `<code style="font-family:${MONO};">${out}</code>`;
        }
        for (const m of marks) {
          if (m.type === 'link') {
            const href = linkOf(m, email);
            if (href)
              out = `<a href="${esc(href)}" style="color:${color};text-decoration:underline;">${out}</a>`;
          } else if (m.type === 'footnote_reference') {
            notes.push(m.attrs.text);
            out += `<sup>${notes.length}</sup>`;
          }
        }
        return out;
      })
      .join('');

  const richText = (doc: RichTextDoc, color = theme.link) => {
    const notes: string[] = [];
    const block = (node: RichNode, inItem = false): string => {
      switch (node.type) {
        case 'paragraph':
          return `<p style="margin:${inItem ? '0' : '0 0 14px'};">${inline(node.content as Inline[], notes, color)}</p>`;
        case 'heading': {
          // Levels 1-3 sit under the block level (h2), as on the site (headings.ts): h2 to h4.
          const level = (node.attrs as { level: number }).level;
          const tag = (['h2', 'h3', 'h4'] as const)[level - 1] ?? 'h4';
          return heading(
            tag,
            inline(node.content as Inline[], notes, color),
            level === 1 ? 20 : 18,
            '16px 0 8px'
          );
        }
        case 'bullet_list':
        case 'ordered_list': {
          const tag = node.type === 'bullet_list' ? 'ul' : 'ol';
          const start = (node.attrs as { start?: number } | undefined)?.start;
          const items = (node.content ?? [])
            .map(
              (li) =>
                `<li style="margin:0 0 6px;">${(li.content ?? []).map((c) => block(c, true)).join('')}</li>`
            )
            .join('');
          return `<${tag}${start && start !== 1 ? ` start="${start}"` : ''} style="margin:0 0 14px;padding-left:24px;">${items}</${tag}>`;
        }
        default:
          throw new Error(`unknown rich-text node ${node.type}`);
      }
    };
    const body = doc.content.map((n) => block(n as RichNode)).join('');
    if (!notes.length) return body;
    return `${body}<p style="margin:8px 0 4px;font-size:14px;font-weight:700;">${esc(email.copy.footnotes)}</p><ol style="margin:0 0 14px;padding-left:24px;font-size:14px;">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ol>`;
  };

  const caption = (i: EmailImage) => {
    const line = [i.caption, i.credit].filter(Boolean).map((s) => esc(s!));
    return line.length
      ? `<p style="margin:6px 0 0;font-size:14px;line-height:1.4;">${line.join(' · ')}</p>`
      : '';
  };
  const image = (i: EmailImage, width = WIDTH - 2 * GUTTER) =>
    `<img src="${esc(i.src)}" alt="${esc(i.alt)}" width="${Math.min(width, i.width)}" style="display:block;width:100%;max-width:${Math.min(width, i.width)}px;height:auto;border:0;">${caption(i)}`;

  const blockHtml = (b: EmailBlock): string => {
    switch (b.type) {
      case 'heading':
        return heading('h2', esc(b.text), 24, '8px 0 0');
      case 'rich-text':
        return richText(b.doc);
      case 'image':
        return image(b.image);
      case 'gallery':
        return b.images.map((i) => `<div style="margin:0 0 16px;">${image(i)}</div>`).join('');
      case 'panel': {
        const tone = b.tone === 'accent' ? theme.accent : theme.surface;
        return box(
          tone,
          [
            b.image
              ? `<div style="margin:0 0 16px;">${image(b.image, WIDTH - 2 * GUTTER - 40)}</div>`
              : '',
            b.label ? `<p style="margin:0 0 4px;font-size:14px;">${esc(b.label)}</p>` : '',
            heading('h2', esc(b.title), 20, '0'),
            b.body ? `<p style="margin:8px 0 0;">${esc(b.body)}</p>` : '',
            b.actions.length
              ? `<p style="margin:4px 0 0;">${b.actions.map(button).join('')}</p>`
              : '',
          ].join('')
        );
      }
      case 'callout': {
        const tone = b.tone === 'warning' ? theme.warning : theme.surface;
        const edge = b.tone === 'warning' ? theme.warning.foreground : theme.primary.background;
        return box(
          tone,
          [
            `<p style="margin:0 0 6px;font-size:14px;font-weight:700;">${esc(b.label)}</p>`,
            b.title ? heading('h2', esc(b.title), 20, '0 0 8px') : '',
            richText(b.doc, tone.foreground),
          ].join(''),
          `border-left:4px solid ${edge};`
        );
      }
      case 'qa':
        return heading('h2', esc(b.question), 20, '0 0 8px') + richText(b.answer);
      case 'quote':
        return `<blockquote style="margin:0;padding:0 0 0 16px;border-left:4px solid ${theme.accent.background};"><p style="margin:0;font-family:${head};font-size:21px;line-height:1.4;font-style:italic;">${esc(b.text)}</p>${b.cite ? `<p style="margin:8px 0 0;font-size:15px;">${esc(b.cite)}</p>` : ''}</blockquote>`;
      case 'link':
        return `<p style="margin:0;">${link(b.href, `${esc(b.text)} &rarr;`, 'font-weight:700;')}</p>`;
      default:
        return b satisfies never;
    }
  };

  const hero = email.hero ? row(image(email.hero)) : '';
  const blocks = email.blocks.map((b) => row(blockHtml(b))).join('');
  const preheader = email.lead
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(email.lead)}</div>`
    : '';
  const outer = `background-color:${theme.surface.background};color:${theme.surface.foreground};`;
  return [
    '<!doctype html>',
    `<html lang="${esc(email.locale)}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light">',
    `<title>${esc(email.subject)}</title></head>`,
    `<body style="margin:0;padding:0;${outer}">`,
    preheader,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;${outer}">`,
    `<tr><td align="center" style="padding:12px 8px;font-family:${SANS};font-size:13px;">`,
    `<a href="${esc(email.webUrl)}" style="color:${theme.surface.foreground};text-decoration:underline;">${esc(email.copy.viewInBrowser)}</a>`,
    '</td></tr>',
    '<tr><td align="center" style="padding:0 8px 24px;">',
    `<table role="presentation" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${WIDTH}px;background-color:${theme.body.background};color:${theme.body.foreground};font-family:${SANS};font-size:17px;line-height:1.55;">`,
    `<tr><td style="padding:16px ${GUTTER}px;background-color:${theme.primary.background};font-size:18px;font-weight:700;"><a href="${esc(email.site.url)}" style="color:${theme.primary.foreground};text-decoration:none;">${esc(email.site.name)}</a></td></tr>`,
    row(
      heading('h1', esc(email.title), 32, '0') +
        (email.lead
          ? `<p style="margin:12px 0 0;font-size:20px;line-height:1.5;">${esc(email.lead)}</p>`
          : ''),
      `28px ${GUTTER}px 20px`
    ),
    hero,
    blocks,
    `<tr><td style="padding:20px ${GUTTER}px;font-size:14px;${outer}">${esc(email.copy.footer)} ${link(email.site.url, esc(email.site.url.replace(/^https?:\/\//, '')), `color:${theme.surface.foreground};`)}</td></tr>`,
    '</table>',
    '</td></tr></table>',
    '</body></html>',
    '',
  ].join('\n');
}

// --- text ---------------------------------------------------------------------------------------

function renderText(email: EmailDocument): string {
  const inline = (nodes: readonly Inline[] | undefined, notes: string[]) =>
    (nodes ?? [])
      .map((n) => {
        if (n.type === 'hard_break') return '\n';
        let out = n.text;
        for (const m of n.marks ?? []) {
          if (m.type === 'link') {
            const href = linkOf(m, email);
            if (href && href !== out) out = `${out} (${href})`;
          } else if (m.type === 'footnote_reference') {
            notes.push(m.attrs.text);
            out += `[${notes.length}]`;
          }
        }
        return out;
      })
      .join('');

  const richText = (doc: RichTextDoc): string => {
    const notes: string[] = [];
    const block = (node: RichNode, indent = ''): string => {
      switch (node.type) {
        case 'paragraph':
          return indent + inline(node.content as Inline[], notes);
        case 'heading':
          return inline(node.content as Inline[], notes).toUpperCase();
        case 'bullet_list':
        case 'ordered_list': {
          const start = (node.attrs as { start?: number } | undefined)?.start ?? 1;
          return (node.content ?? [])
            .map((li, i) => {
              const marker = node.type === 'bullet_list' ? '-' : `${start + i}.`;
              const pad = `${indent}${' '.repeat(marker.length + 1)}`;
              const [first, ...rest] = li.content ?? [];
              return [
                `${indent}${marker} ${first ? block(first).trimStart() : ''}`,
                ...rest.map((c) => block(c, pad)),
              ].join('\n');
            })
            .join('\n');
        }
        default:
          throw new Error(`unknown rich-text node ${node.type}`);
      }
    };
    const body = doc.content.map((n) => block(n as RichNode)).join('\n\n');
    return notes.length
      ? `${body}\n\n${email.copy.footnotes}\n${notes.map((n, i) => `[${i + 1}] ${n}`).join('\n')}`
      : body;
  };
  const underline = (s: string, c: string) => `${s}\n${c.repeat(Math.min(s.length, 60))}`;
  const image = (i: EmailImage) =>
    [i.alt ? `[${i.alt}]` : '', [i.caption, i.credit].filter(Boolean).join(' · ')]
      .filter(Boolean)
      .join('\n');
  const action = (a: EmailAction) => `${a.label}: ${a.href}`;

  const blockText = (b: EmailBlock): string => {
    switch (b.type) {
      case 'heading':
        return underline(b.text, '-');
      case 'rich-text':
        return richText(b.doc);
      case 'image':
        return image(b.image);
      case 'gallery':
        return b.images.map(image).filter(Boolean).join('\n\n');
      case 'panel':
        return [
          b.image ? image(b.image) : '',
          b.label ?? '',
          b.title.toUpperCase(),
          b.body ?? '',
          ...b.actions.map(action),
        ]
          .filter(Boolean)
          .join('\n');
      case 'callout':
        return [b.label.toUpperCase(), b.title ?? '', richText(b.doc)].filter(Boolean).join('\n');
      case 'qa':
        return `${b.question.toUpperCase()}\n${richText(b.answer)}`;
      case 'quote':
        return [`"${b.text}"`, b.cite ?? ''].filter(Boolean).join('\n');
      case 'link':
        return `${b.text}: ${b.href}`;
      default:
        return b satisfies never;
    }
  };

  return `${[
    `${email.site.name}`,
    `${email.copy.viewInBrowser}: ${email.webUrl}`,
    underline(email.title, '='),
    email.lead ?? '',
    email.hero ? image(email.hero) : '',
    ...email.blocks.map(blockText),
    `--\n${email.copy.footer}\n${email.site.url}`,
  ]
    .filter(Boolean)
    .join('\n\n')}\n`;
}
