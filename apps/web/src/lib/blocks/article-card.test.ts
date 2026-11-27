// The article card's own rules (redesign of 2026-11-27): the excerpt it cuts, the one line of
// facts under the title, and the fit an image's framing names. How the card looks is CSS, proven
// in the browser (e2e/lib/blocks/overview-cards.ts); the theme's card choice in tokens.test.ts.
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ArticleCard, { cardExcerpt } from './ArticleCard.svelte';
import { framingAttributes } from './framing.js';

const card = (props: Partial<Parameters<typeof render<typeof ArticleCard>>[1]['props']> = {}) =>
  render(ArticleCard, {
    props: {
      title: 'Zes nieuwe faunapassages in één jaar',
      href: '/nieuws/faunapassages',
      base: '',
      image: null,
      sizes: '100vw',
      heading: 'h3',
      date: { iso: '2026-10-08', label: '8 oktober 2026' },
      summary: null,
      ...props,
    },
  }).body.replace(/<!--.*?-->/g, '');

describe('the excerpt of a card', () => {
  it('keeps a summary that fits, with its white space flattened', () => {
    expect(cardExcerpt('Wat begon met één richel,\n is nu   beleid.')).toBe(
      'Wat begon met één richel, is nu beleid.'
    );
    const fits = 'a'.repeat(120);
    expect(cardExcerpt(fits)).toBe(fits);
  });

  it('ends on whole sentences when they fill at least half the room', () => {
    const summary =
      'De regering in België staat op omvallen over de vraag of miljonairs meer belasting moeten gaan betalen. En dat is niet het enige probleem van deze week.';
    expect(cardExcerpt(summary)).toBe(
      'De regering in België staat op omvallen over de vraag of miljonairs meer belasting moeten gaan betalen.'
    );
    expect(
      cardExcerpt(
        'Wie een bril uitzoekt, ziet vooral monturen en prijskaartjes. Wat gebeurt er aan de andere kant van de toonbank? Daar gaat dit stuk over, in drie delen.'
      )
    ).toBe(
      'Wie een bril uitzoekt, ziet vooral monturen en prijskaartjes. Wat gebeurt er aan de andere kant van de toonbank?'
    );
  });

  it('never ends on an abbreviation, and cuts on a word with an ellipsis otherwise', () => {
    const doctor =
      'Rechtspopulisten beloven een revolutie maar leveren regelrechte oplichterij, zegt de econoom en antropoloog Dr. Jason Hickel in dit gesprek over groei.';
    const cut = cardExcerpt(doctor);
    expect(cut.endsWith('Dr.')).toBe(false);
    expect(cut.endsWith('…')).toBe(true);
    expect(Array.from(cut).length).toBeLessThanOrEqual(120);
    expect(doctor.startsWith(cut.slice(0, -1))).toBe(true);
    expect(doctor[cut.length - 1]).toBe(' ');
    // A short first sentence does not make the excerpt: the room would stay half empty.
    const short = `Kort. ${'woord '.repeat(40)}`;
    expect(cardExcerpt(short).endsWith('…')).toBe(true);
    // No comma or colon before the ellipsis.
    expect(cardExcerpt(`${'woord '.repeat(19)}woor, ${'woord '.repeat(10)}`)).not.toMatch(
      /[,;:.]…$/
    );
  });

  it('counts letters, not code units, so an emoji is never cut in half', () => {
    const family = '👨‍👩‍👧‍👦';
    const cut = cardExcerpt(`${family.repeat(119)} ${family.repeat(10)}`);
    expect(cut).toBe(`${family.repeat(119)}…`);
  });
});

describe('the facts under the title', () => {
  it('stand in one paragraph, each fact an element of its own for the dot between them', () => {
    const body = card({
      place: 'Buurthuis De Singel',
      restrictedLabel: 'Voor leden',
      recording: { label: 'Video', duration: { iso: 'PT41M', label: '41 min' } },
      summary: 'Twee minuten otters, zonder commentaar.',
    });
    const meta = /<p class="overview-meta">(.*?)<\/p>/s.exec(body)![1]!;
    expect(meta).toMatch(
      /<time class="overview-date" datetime="2026-10-08">8 oktober 2026<\/time>/
    );
    expect(meta).toMatch(
      /<span class="overview-recording">.*Video · <time datetime="PT41M">41 min/s
    );
    expect(meta).toContain('<span class="overview-place">Buurthuis De Singel</span>');
    expect(meta).toContain('<span class="overview-access">Voor leden</span>');
    // Read without the stylesheet the facts still stand apart.
    expect(
      meta
        .replace(/<svg.*?<\/svg>/s, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    ).toBe('8 oktober 2026 Video · 41 min Buurthuis De Singel Voor leden');
    expect(body).toContain(
      '<p class="overview-excerpt">Twee minuten otters, zonder commentaar.</p>'
    );
    // The title comes first and is the card's only link.
    expect(body.indexOf('overview-card-title')).toBeLessThan(body.indexOf('overview-meta'));
    expect(body.match(/<a /g)).toHaveLength(1);
  });

  it('is only the date on a plain article, and no excerpt without a summary', () => {
    const body = card();
    expect(body).toMatch(
      /<p class="overview-meta">\s*<time class="overview-date"[^>]*>8 oktober 2026<\/time>\s*<\/p>/
    );
    expect(body).not.toContain('overview-excerpt');
  });
});

describe('the fit an image framing names', () => {
  const mediaId = '6f1d4c9e-2b1a-4a53-9a57-0d2f6c3b7e11';
  const unset = { x: 0.5, y: 0.5, mode: 'auto' } as const;
  const set = { x: 0.3, y: 0.2, mode: 'explicit' } as const;

  it('tells no choice from the whole image an editor asked for', () => {
    // An image nobody framed: `auto`, which a card fills around the focal point.
    expect(framingAttributes(undefined, unset)).toEqual({
      'data-frame-fit': 'auto',
    });
    expect(framingAttributes({ mediaId, framing: { mode: 'auto' } }, set)).toEqual({
      'data-frame-fit': 'auto',
    });
    // "Full image" stays whole everywhere, a card included.
    expect(
      framingAttributes({ mediaId, framing: { mode: 'full' }, narrow: { mode: 'auto' } }, set)
    ).toEqual({ 'data-frame-fit': 'contain', 'data-frame-fit-narrow': 'auto' });
    expect(
      framingAttributes(
        {
          mediaId,
          framing: { mode: 'manual', point: { x: 0.5, y: 0.12 } },
          wide: { mode: 'full' },
        },
        set
      )
    ).toEqual({
      'data-frame-fit': 'cover',
      'data-frame-x': '50',
      'data-frame-y': '12',
      'data-frame-fit-wide': 'contain',
    });
    // A focal point set on the media and no placement: the classes of the point do the work.
    expect(framingAttributes(undefined, set)).toEqual({});
  });
});
