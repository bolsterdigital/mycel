// The Markdown subset round-trips losslessly (brief content-editor § B, ADR 020 rule 5): every
// rich text in the registry examples, hand-picked edge cases, and a fixed fuzz set of generated
// documents. Fixed, not a property-test library: a seeded generator gives the same thousand
// documents on every run and needs no dependency admission (ADR 008).

import { describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS, RichTextDoc, type Mark } from '@mycel/core';
import { canonicalRichText, fromMarkdown, toMarkdown } from './markdown.js';

function roundTrip(doc: RichTextDoc) {
  const md = toMarkdown(doc);
  const back = fromMarkdown(md);
  expect(back, md).toEqual({ ok: true, doc: canonicalRichText(doc) });
  // And the text is canonical too: writing the result again gives the same Markdown.
  if (back.ok) expect(toMarkdown(back.doc)).toBe(md);
  return md;
}

/** Every `RichTextDoc` in the registry examples, found by shape. */
function docsIn(value: unknown): RichTextDoc[] {
  if (!value || typeof value !== 'object') return [];
  if ((value as { type?: unknown }).type === 'doc') return [value as RichTextDoc];
  return Object.values(value).flatMap(docsIn);
}

const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const t = (text: string, ...marks: Mark[]) =>
  marks.length ? { type: 'text', text, marks } : { type: 'text', text };
const doc = (...content: unknown[]) => RichTextDoc.parse({ type: 'doc', content });
const bold: Mark = { type: 'bold' };
const italic: Mark = { type: 'italic' };
const code: Mark = { type: 'code' };
const link = (href: string): Mark => ({ type: 'link', attrs: { href } });
const note = (text: string): Mark => ({ type: 'footnote_reference', attrs: { text } });

describe('rich text as Markdown', () => {
  const examples = Object.values(BLOCK_DEFINITIONS).flatMap((d) =>
    d.examples.flatMap((e) => docsIn(e.props))
  );

  it('round-trips every rich text of the registry examples', () => {
    expect(examples.length).toBeGreaterThan(5);
    for (const d of examples) roundTrip(d);
  });

  it('writes the subset a redacteur expects', () => {
    const md = roundTrip(
      doc(
        { type: 'heading', attrs: { level: 1 }, content: [t('Waarom')] },
        p(t('Een '), t('vet', bold), t(' en '), t('schuin', italic), t(' woord.')),
        {
          type: 'bullet_list',
          content: [
            { type: 'list_item', content: [p(t('een'))] },
            {
              type: 'list_item',
              content: [
                p(t('twee')),
                {
                  type: 'ordered_list',
                  attrs: { start: 3 },
                  content: [{ type: 'list_item', content: [p(t('drie'))] }],
                },
              ],
            },
          ],
        },
        p(t('Zie '), t('de bron', link('https://example.org/a_(b)')), t('.', note('RIVM, 2025.')))
      )
    );
    expect(md).toBe(
      [
        '## Waarom',
        '',
        'Een **vet** en _schuin_ woord.',
        '',
        '- een',
        '- twee',
        '  3. drie',
        '',
        'Zie [de bron](https://example.org/a_(b\\))[.][^1]',
        '',
        '[^1]: RIVM, 2025.',
      ].join('\n')
    );
  });

  it('keeps what plain Markdown would lose', () => {
    roundTrip(doc(p(t('wo'), t('rd', bold), t('deel'))));
    roundTrip(
      doc(p(t('a', bold, italic, link('/x')), t('b', italic, link('/x')), t('c', link('/x'))))
    );
    roundTrip(doc(p(t('a', link('/x')), t('b', link('/x'), note('n')), t('c', note('n')))));
    roundTrip(doc(p(t('1. geen lijst')), p(t('- ook niet')), p(t('# geen kop')), p(t(' spatie'))));
    roundTrip(doc(p(t('*_`[]\\ <br> &#32; &amp; [^1]: x'))));
    roundTrip(doc(p(t('a\nb\tc\r')), p({ type: 'hard_break' }, t('-'), { type: 'hard_break' })));
    roundTrip(doc(p(), { type: 'paragraph', content: [] }, p({ type: 'hard_break' })));
    roundTrip(
      doc(
        { type: 'heading', attrs: { level: 1 } },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [t('a'), { type: 'hard_break' }, t('# b')],
        }
      )
    );
    roundTrip(doc(p(t('code met ** en _', code))));
    roundTrip(doc(p(t('x', note(' begint met spatie \\ en &#9; \n'))), p(t('y', note('[^2]: ]')))));
    roundTrip(
      doc(
        { type: 'bullet_list', content: [{ type: 'list_item', content: [p(t('a'))] }] },
        { type: 'bullet_list', content: [{ type: 'list_item', content: [p(t('b'))] }] },
        { type: 'ordered_list', content: [{ type: 'list_item', content: [p(), p(t('c'))] }] },
        {
          type: 'ordered_list',
          attrs: { start: 1 },
          content: [{ type: 'list_item', content: [p(t('d'))] }],
        }
      )
    );
  });

  it('reads what people type: CRLF, loose items, a single newline as a space', () => {
    const read = fromMarkdown('Een\r\nregel\r\n\r\n- a\r\n\r\n- b\r\n');
    expect(read).toEqual({
      ok: true,
      doc: doc(p(t('Een regel')), {
        type: 'bullet_list',
        content: [
          { type: 'list_item', content: [p(t('a'))] },
          { type: 'list_item', content: [p(t('b'))] },
        ],
      }),
    });
    expect(fromMarkdown('[sic] en [open')).toEqual({ ok: true, doc: doc(p(t('[sic] en [open'))) });
  });

  it('refuses what it cannot read, with the line', () => {
    expect(fromMarkdown('a\n\n[b](https://x')).toEqual({
      ok: false,
      error: { line: 3, message: 'editor.markdown.unclosed-link' },
    });
    expect(fromMarkdown('[a][^9]')).toEqual({
      ok: false,
      error: { line: 1, message: 'editor.markdown.unknown-footnote' },
    });
    // Valid syntax, invalid document: an unsafe link, a skipped heading level, nothing at all.
    for (const md of ['[a](javascript:alert(1\\))', '## a\n\n#### b', '', '[a](item:nope)'])
      expect(fromMarkdown(md).ok, md).toBe(false);
  });
});

// --- the fuzz set -------------------------------------------------------------------------------

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  'a',
  'b',
  'Z',
  '1',
  '2',
  ' ',
  ' ',
  '.',
  ')',
  '-',
  '+',
  '#',
  '*',
  '_',
  '`',
  '[',
  ']',
  '(',
  '\\',
  '<',
  'br>',
  '&',
  '#9;',
  '^',
  ':',
  '\n',
  '\t',
  'é',
  '€',
];

function generate(random: () => number) {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  const text = () =>
    Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(ALPHABET)).join('');
  const marks = (): Mark[] => {
    const out: Mark[] = [];
    if (random() < 0.3) out.push(bold);
    if (random() < 0.3) out.push(italic);
    if (random() < 0.15) out.push(code);
    if (random() < 0.2)
      out.push(
        random() < 0.5
          ? link(pick(['/a', 'https://example.org/x?y=(1)', 'mailto:a@b.nl']))
          : { type: 'link', attrs: { itemId: '01900000-0000-7000-8000-00000000c001' } }
      );
    if (random() < 0.15) out.push(note(text()));
    return out.sort(() => random() - 0.5);
  };
  const inline = () =>
    Array.from({ length: Math.floor(random() * 5) }, () =>
      random() < 0.12 ? { type: 'hard_break' } : t(text(), ...marks())
    );
  const paragraph = () => (random() < 0.1 ? { type: 'paragraph' } : p(...inline()));
  const list = (depth: number): unknown => {
    const ordered = random() < 0.5;
    return {
      type: ordered ? 'ordered_list' : 'bullet_list',
      ...(ordered && random() < 0.4 ? { attrs: { start: 1 + Math.floor(random() * 12) } } : {}),
      content: Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
        type: 'list_item',
        content: [
          paragraph(),
          ...Array.from({ length: Math.floor(random() * 3) }, () =>
            depth < 3 && random() < 0.5 ? list(depth + 1) : paragraph()
          ),
        ],
      })),
    };
  };
  let level = 0;
  const top = () => {
    const r = random();
    if (r < 0.2) {
      level = Math.max(1, Math.min(3, level + pick([-1, 0, 1])));
      return {
        type: 'heading',
        attrs: { level },
        ...(random() < 0.9 ? { content: inline() } : {}),
      };
    }
    return r < 0.45 ? list(1) : paragraph();
  };
  return { type: 'doc', content: Array.from({ length: 1 + Math.floor(random() * 6) }, top) };
}

describe('rich text as Markdown, fuzzed', () => {
  it('round-trips a thousand generated documents', () => {
    const random = rng(20261023);
    let checked = 0;
    for (let n = 0; n < 1000; n++) {
      const parsed = RichTextDoc.safeParse(generate(random));
      if (!parsed.success) continue;
      roundTrip(parsed.data);
      checked++;
    }
    expect(checked).toBeGreaterThan(950);
  });
});
