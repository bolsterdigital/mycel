import { describe, expect, it } from 'vitest';
import { heroAltView } from './hero-alt.js';

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
