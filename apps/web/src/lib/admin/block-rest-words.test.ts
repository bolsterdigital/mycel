import { describe, expect, it } from 'vitest';
import { ui } from '../../i18n/index.js';
import { blockNotice, restWords } from './block-rest-words.js';

const nl = ui('nl');
const en = ui('en');
const shape = { kind: 'form', variant: 'card', variantFrom: 'v', idFrom: 'i' } as const;
const form = (name: string) => ({ name, list: 'legacy-slug', fields: [], submit: 'Ja' });

describe('restWords', () => {
  it('names a callout by its variant and a video by its host, in the language of the screen', () => {
    const callout = {
      kind: 'callout',
      variant: 'info',
      variantFrom: 'v',
      title: '',
      titleFrom: 't',
      html: '',
      proseFrom: 'p',
    } as const;
    expect(restWords(callout, false, nl).kindLabel).toBe('Informatie');
    expect(restWords(callout, false, en).kindLabel).toBe('Information');
    const video = {
      kind: 'video',
      provider: 'youtube',
      providerFrom: 'p',
      title: '',
      titleFrom: 't',
      caption: '',
      captionFrom: 'c',
    } as const;
    expect(restWords(video, false, nl).kindLabel).toBe('YouTube');
  });

  it('names the linked form, and that a reference found nothing', () => {
    const found = { ...shape, form: form('nieuws') };
    expect(restWords(found, false, nl).kindLabel).toBe('nieuws');
    const missing = { ...shape, form: null };
    expect(restWords(missing, false, nl).kindLabel).toBe(nl('admin.block.form.missing'));
    const unread = { ...shape, form: null, unread: true } as const;
    expect(restWords(unread, false, nl).kindLabel).toBe(nl('admin.block.form.unread'));
    expect(restWords(found, true, nl).noteLabel).toBe(nl('admin.block.form.changed'));
  });

  it('says a paywall holds nobody back only on a public item', () => {
    const paywall = { kind: 'paywall' } as const;
    expect(restWords(paywall, false, nl)).toEqual({
      kindLabel: nl('admin.block.paywall.boundary'),
      noteLabel: 'Deze pagina is openbaar, dus voorlopig leest iedereen verder.',
    });
    expect(restWords(paywall, true, nl)).toEqual({
      kindLabel: nl('admin.block.paywall.boundary'),
      noteLabel: undefined,
    });
  });
});

describe('blockNotice', () => {
  const screen = { work: 'nl', locale: 'nl' };
  const issue = (field: string) => ({ field });

  it('names the language a block is not ready in, in the language of the screen', () => {
    const publication = [{ locale: 'en', issues: [issue('block-a')] }];
    expect(blockNotice({ id: 'a', refused: false }, publication, screen, nl)).toBe(
      'Nog niet klaar in Engels'
    );
    expect(
      blockNotice({ id: 'a', refused: false }, publication, { work: 'nl', locale: 'en-GB' }, en)
    ).toBe('Not ready in English');
  });

  it('prefers the shown locale, and says nothing about a block that is ready', () => {
    const publication = [
      { locale: 'en', issues: [issue('block-a')] },
      { locale: 'nl', issues: [issue('block-a'), issue('block-b')] },
    ];
    expect(blockNotice({ id: 'a', refused: false }, publication, screen, nl)).toBe(
      'Nog niet klaar in Nederlands'
    );
    expect(blockNotice({ id: 'c', refused: false }, publication, screen, nl)).toBe('');
  });

  it('puts what the last save refused before readiness', () => {
    const publication = [{ locale: 'nl', issues: [issue('block-a')] }];
    expect(blockNotice({ id: 'a', refused: true }, publication, screen, nl)).toBe(
      nl('admin.block.card.refused')
    );
  });
});
