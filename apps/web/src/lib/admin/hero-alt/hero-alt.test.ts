import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import HeroAltRow from './HeroAltRow.svelte';
import { heroAltView, imageAltProps } from './hero-alt.js';

const base = { text: '', others: {}, replaced: false, clearing: false, flagged: false };

describe('heroAltView (#158)', () => {
  it('calls an image without text anywhere decorative, in a neutral tone', () => {
    expect(heroAltView(base)).toMatchObject({ state: 'decorative', tone: 'neutral' });
    expect(heroAltView({ ...base, others: { en: '  ' } })).toMatchObject({ state: 'decorative' });
  });

  it('shows the text as the state, and which other locale still lacks it', () => {
    expect(heroAltView({ ...base, text: 'Het team' })).toMatchObject({
      state: 'described',
      tone: 'ok',
      lacking: [],
    });
    expect(heroAltView({ ...base, text: 'Het team', others: { en: '', de: 'Das Team' } })).toEqual({
      state: 'described',
      tone: 'ok',
      lacking: ['en'],
      described: ['de'],
    });
  });

  it('warns here only while another locale has text', () => {
    expect(heroAltView({ ...base, others: { nl: 'Het team' } })).toMatchObject({
      state: 'missing',
      tone: 'warn',
      described: ['nl'],
    });
  });

  it('treats stored text as gone for a replaced image', () => {
    const replaced = { ...base, others: { en: 'The team' }, replaced: true };
    expect(heroAltView(replaced)).toMatchObject({ state: 'fresh', tone: 'info', described: [] });
    expect(heroAltView({ ...replaced, text: 'Het plein' })).toMatchObject({
      state: 'described',
      lacking: ['en'],
    });
  });

  it('makes a refusal an error, with or without text on screen', () => {
    expect(heroAltView({ ...base, flagged: true })).toMatchObject({
      state: 'missing',
      tone: 'err',
    });
    expect(
      heroAltView({ ...base, text: 'Het team', others: { en: '' }, flagged: true })
    ).toMatchObject({ state: 'described', tone: 'err', lacking: ['en'] });
  });

  it('lets the box win: decorative after saving, whatever the fields hold', () => {
    expect(
      heroAltView({ ...base, text: 'Het team', others: { en: 'The team' }, clearing: true })
    ).toMatchObject({ state: 'cleared', tone: 'neutral' });
  });
});

// The writer's new image cards use the same explicit pair as the merged native image form.
describe('image description storage', () => {
  it('stores decorative only for an absent map, without repairing invalid input', () => {
    expect(imageAltProps(null)).toEqual({ decorative: true, alt: null });
    expect(imageAltProps({ en: 'The square' })).toEqual({
      decorative: false,
      alt: { en: 'The square' },
    });
    expect(imageAltProps({})).toEqual({ decorative: false, alt: {} });
  });
});

// SSR is the native/no-JavaScript path for both uses of the same description component.
describe('description row markup', () => {
  const props = {
    work: 'nl',
    locales: ['nl', 'en'],
    image: 'img',
    savedImage: 'img',
    text: '',
    savedText: '',
    others: { en: 'The square' },
  };
  it.each(['nl', 'en'])(
    'wires a standalone image and its all-language clear action in %s',
    (locale) => {
      const out = render(HeroAltRow, {
        props: {
          ...props,
          locale,
          block: true,
          fieldId: 'b-img-p-alt-nl',
          fieldName: 'b.img.p.alt.nl',
          clearName: 'b.img.imageAltClear',
          markerName: 'b.img.imageAltShown',
          imageName: 'b.img.p.mediaId',
          flagged: true,
        },
      }).body;
      expect(out).toContain('data-block-alt');
      expect(out).toMatch(/<details[^>]* open/);
      expect(out).toContain('name="b.img.imageAltShown" value="1"');
      expect(out).toContain('name="b.img.p.alt.nl"');
      expect(out).toContain('for="b-img-p-alt-nl"');
      expect(out).toContain('name="b.img.imageAltClear"');
      expect(out).toContain('aria-invalid="true"');
      expect(out).toContain('The square');
      expect(out).not.toContain('name="heroAlt.nl"');
      expect(out).toContain(locale === 'nl' ? 'omringende inhoud' : 'surrounding content');
    }
  );
  it('keeps the document hero default field names and explanation', () => {
    const out = render(HeroAltRow, { props: { ...props, locale: 'en' } }).body;
    expect(out).toContain('name="heroAltShown"');
    expect(out).toContain('name="heroAlt.nl"');
    expect(out).toContain('name="heroDecorative"');
    expect(out).toContain('id="heroDecorative"');
    expect(out).toContain('title and lead');
    expect(out).not.toContain('data-block-alt');
  });
});
