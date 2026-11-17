// The renderer's contract: one HTML and one text snapshot per block type and locale,
// built by the core from the registry examples (`emailExamples`), so a new type or a markup change
// shows in review. Beside the snapshots, the rules a mail client relies on: every style inline, no
// `<style>` or `<script>`, every link absolute, text escaped.

import { BLOCK_TYPES } from '@mycel/core';
import { emailExamples } from '@mycel/core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderEmail } from './index.js';

let fixture: Awaited<ReturnType<typeof emailExamples>>;
beforeAll(async () => {
  fixture = await emailExamples();
});

/** The ids the fixture creates differ per run order only in their counters; snapshots name them. */
const stable = (s: string) =>
  s.replaceAll(fixture.imageId, '<image>').replaceAll(fixture.linkedItemId, '<item>');

describe('render-email', () => {
  for (const type of BLOCK_TYPES)
    for (const locale of ['nl', 'en'] as const)
      it(`renders ${type} in ${locale}`, () => {
        const { email } = fixture.examples.find((e) => e.type === type && e.locale === locale)!;
        const { html, text } = renderEmail(email);
        const body = html.slice(
          html.indexOf('<tr><td style="padding:28px'),
          html.lastIndexOf('<tr><td style="padding:20px 24px')
        );
        expect(stable(body)).toMatchSnapshot('html');
        expect(stable(text)).toMatchSnapshot('text');
      });

  it('renders the header, the frame and the footer', () => {
    for (const locale of ['nl', 'en'] as const) {
      const { html, text } = renderEmail(fixture.header[locale]);
      expect(stable(html)).toMatchSnapshot(`html ${locale}`);
      expect(stable(text)).toMatchSnapshot(`text ${locale}`);
    }
  });

  it('keeps every style inline and every link absolute', () => {
    for (const { email } of [...fixture.examples, { email: fixture.header.nl }]) {
      const { html } = renderEmail(email);
      expect(html).not.toMatch(/<style|<script|class=/i);
      for (const [, href] of html.matchAll(/(?:href|src)="([^"]*)"/g))
        expect(href).toMatch(/^(https?:\/\/|mailto:|tel:)/);
    }
  });

  it('escapes text and leaves an unsafe or unresolved link as text', () => {
    const email = {
      ...fixture.header.en,
      title: '<b>Fish & "chips"</b>',
      links: { '00000000-0000-4000-8000-000000000001': null },
      blocks: [
        {
          type: 'rich-text' as const,
          doc: {
            type: 'doc' as const,
            content: [
              {
                type: 'paragraph' as const,
                content: [
                  {
                    type: 'text' as const,
                    text: 'gone',
                    marks: [
                      {
                        type: 'link' as const,
                        attrs: { itemId: '00000000-0000-4000-8000-000000000001' },
                      },
                    ],
                  },
                  { type: 'text' as const, text: ' and ' },
                  {
                    type: 'text' as const,
                    text: 'relative',
                    marks: [{ type: 'link' as const, attrs: { href: '/agenda' } }],
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    const { html, text } = renderEmail(email);
    expect(html).toContain('&lt;b&gt;Fish &amp; &quot;chips&quot;&lt;/b&gt;');
    expect(html).toContain(
      '<p style="margin:0 0 14px;">gone and <a href="https://vogelwijk.example.org/agenda"'
    );
    expect(text).toContain('gone and relative (https://vogelwijk.example.org/agenda)');
  });

  it('gives a passage in another language its own lang and dir, and the text only its words', () => {
    const email = {
      ...fixture.header.nl,
      blocks: [
        {
          type: 'rich-text' as const,
          doc: {
            type: 'doc' as const,
            content: [
              {
                type: 'paragraph' as const,
                content: [
                  { type: 'text' as const, text: 'Zij zei ' },
                  {
                    type: 'text' as const,
                    text: 'شكرا',
                    marks: [{ type: 'lang' as const, attrs: { lang: 'ar' } }],
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    const { html, text } = renderEmail(email);
    expect(html).toContain('<html lang="nl" dir="ltr">');
    expect(html).toContain('Zij zei <span lang="ar" dir="rtl">شكرا</span>');
    expect(text).toContain('Zij zei شكرا');
  });
});
