import { describe, expect, it } from 'vitest';
import { toJsonSchema } from '../json-schema.js';
import { RICH_TEXT_LIMITS, RichTextDoc, isSafeHref, linkedItemIds } from './rich-text.js';

const text = (t: string, marks?: unknown[]) => ({
  type: 'text',
  text: t,
  ...(marks ? { marks } : {}),
});
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const h = (level: number, t: string) => ({ type: 'heading', attrs: { level }, content: [text(t)] });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const ok = (value: unknown) => RichTextDoc.safeParse(value).success;
const messages = (value: unknown) =>
  RichTextDoc.safeParse(value).error?.issues.map((i) => i.message) ?? [];

describe('rich text (ADR 020 rule 2)', () => {
  it('accepts prose, relative headings, nested lists, breaks and every mark', () => {
    const item = (...c: unknown[]) => ({ type: 'list_item', content: c });
    expect(
      ok(
        doc(
          h(1, 'Context'),
          p(
            text('bold', [{ type: 'bold' }, { type: 'italic' }]),
            { type: 'hard_break' },
            text('code', [{ type: 'code' }]),
            text('site', [{ type: 'link', attrs: { href: 'https://example.org/a?b=c' } }]),
            text('page', [{ type: 'link', attrs: { href: '/donate' } }]),
            text('mail', [{ type: 'link', attrs: { href: 'mailto:redactie@example.org' } }]),
            text('item', [
              { type: 'link', attrs: { itemId: '01900000-0000-7000-8000-000000000001' } },
            ]),
            text('1', [{ type: 'footnote_reference', attrs: { text: 'Source: annual report.' } }])
          ),
          h(2, 'Detail'),
          {
            type: 'bullet_list',
            content: [
              item(p(text('a')), {
                type: 'ordered_list',
                attrs: { start: 3 },
                content: [item(p(text('b')))],
              }),
            ],
          },
          h(1, 'Next')
        )
      )
    ).toBe(true);
  });

  it.each([
    ['blockquote', doc({ type: 'blockquote', content: [p(text('q'))] })],
    ['an image node', doc({ type: 'image', attrs: { src: 'x.png' } })],
    ['raw html', doc({ type: 'html', html: '<b>x</b>' })],
    ['an unknown mark', doc(p(text('x', [{ type: 'underline' }])))],
    ['an unknown attribute', doc({ type: 'paragraph', attrs: { align: 'center' } })],
    ['a stored h1 (level 0) or h5 (level 4)', doc(h(0, 'x'), h(4, 'y'))],
    [
      'a heading inside a list',
      doc({ type: 'bullet_list', content: [{ type: 'list_item', content: [h(1, 'x')] }] }),
    ],
    [
      'a list item that does not start with a paragraph',
      doc({ type: 'bullet_list', content: [{ type: 'list_item', content: [] }] }),
    ],
    ['an empty document', doc()],
    ['an empty text node', doc(p({ type: 'text', text: '' }))],
    ['a duplicate mark', doc(p(text('x', [{ type: 'bold' }, { type: 'bold' }])))],
    [
      'a link with two targets',
      doc(
        p(
          text('x', [
            { type: 'link', attrs: { href: '/a', itemId: '01900000-0000-7000-8000-000000000001' } },
          ])
        )
      ),
    ],
  ])('rejects %s', (_label, value) => {
    expect(ok(value)).toBe(false);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    '//evil.example/x',
    'https://user:pass@example.org/',
    'ftp://example.org/',
    '/a b',
    '\\\\evil',
    'mailto:',
  ])('refuses the unsafe link %s', (href) => {
    expect(isSafeHref(href)).toBe(false);
    expect(messages(doc(p(text('x', [{ type: 'link', attrs: { href } }]))))).toContain(
      'content.link.unsafe'
    );
  });

  it('refuses a heading that skips a level, but allows going back up', () => {
    expect(messages(doc(h(1, 'a'), h(3, 'b')))).toContain('content.rich-text.heading-skips-level');
    expect(ok(doc(h(1, 'a'), h(2, 'b'), h(3, 'c'), h(1, 'd')))).toBe(true);
  });

  it('bounds list nesting, node count and length', () => {
    const nest = (levels: number) => {
      let list: unknown = {
        type: 'bullet_list',
        content: [{ type: 'list_item', content: [p(text('x'))] }],
      };
      for (let i = 1; i < levels; i++)
        list = {
          type: 'bullet_list',
          content: [{ type: 'list_item', content: [p(text('x')), list] }],
        };
      return doc(list);
    };
    expect(ok(nest(RICH_TEXT_LIMITS.listNesting))).toBe(true);
    expect(ok(nest(RICH_TEXT_LIMITS.listNesting + 1))).toBe(false);

    const many = Array.from({ length: RICH_TEXT_LIMITS.nodes / 2 }, () => p(text('x')));
    expect(messages(doc(...many))).toContain('content.rich-text.too-many-nodes');

    const long = Array.from({ length: 6 }, () => p(text('x'.repeat(RICH_TEXT_LIMITS.textNode))));
    expect(messages(doc(...long))).toContain('content.rich-text.too-long');
  });

  it('lists the content items it links to', () => {
    const id = '01900000-0000-7000-8000-000000000001';
    const parsed = RichTextDoc.parse(doc(p(text('x', [{ type: 'link', attrs: { itemId: id } }]))));
    expect(linkedItemIds(parsed)).toEqual([id]);
  });

  it('converts to JSON Schema without degrading any level to "any"', () => {
    const warn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      expect(JSON.stringify(toJsonSchema(RichTextDoc, 'input'))).toContain('list_item');
    } finally {
      console.warn = warn;
    }
    expect(warnings).toEqual([]);
  });
});
