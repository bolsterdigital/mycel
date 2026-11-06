// The generated block forms round-trip every registry example (brief content-editor § B): the
// form of the stored props reads back as the same props, on top of the stored block and from
// nothing (a new block), and an edit in one locale leaves the others as they were.

import { describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS, BLOCK_TYPES, Block } from '@mycel/core';
import { arrangeRows, formValues, postedValues, propsFromForm } from './block-form.js';

const LOCALES = ['nl', 'en'];

const examples = BLOCK_TYPES.flatMap((type) =>
  BLOCK_DEFINITIONS[type].examples.map((e) => ({
    type,
    name: e.name,
    fields: BLOCK_DEFINITIONS[type].fields,
    props: Block.parse({ id: 'x', type, version: BLOCK_DEFINITIONS[type].version, props: e.props })
      .props as Record<string, unknown>,
  }))
);

describe('block forms', () => {
  it.each(examples)('round-trips $name on the stored block and from nothing', (e) => {
    const values = formValues(e.fields, e.props, LOCALES);
    expect(propsFromForm(e.fields, postedValues(values), e.props)).toEqual({
      props: e.props,
      errors: [],
    });
    expect(propsFromForm(e.fields, postedValues(values))).toEqual({ props: e.props, errors: [] });
  });

  it('stores the kind of an image credit once chosen, and leaves a stored credit without one', () => {
    const image = examples.find((e) => e.name === 'image-wide-caption-credit')!;
    const values = formValues(image.fields, image.props, LOCALES);
    expect(values['p.credit.kind']).toBe('photo');
    expect(propsFromForm(image.fields, postedValues(values), image.props).props).toEqual(
      image.props
    );
    values['p.credit.kind'] = 'illustration';
    const { props, errors } = propsFromForm(image.fields, postedValues(values), image.props);
    expect(errors).toEqual([]);
    expect(props['credit']).toEqual({
      work: null,
      photographer: 'Sam de Vries',
      kind: 'illustration',
    });
  });

  it('drops the alt text of a locale the form does not carry once the image is another (#80)', () => {
    const image = examples.find((e) => e.name === 'image-wide-caption-credit')!;
    const stored = { ...image.props, alt: { nl: 'Oud beeld', en: 'Old picture' } };
    const values = formValues(image.fields, stored, ['nl']);
    expect(propsFromForm(image.fields, postedValues(values), stored).props['alt']).toEqual({
      nl: 'Oud beeld',
      en: 'Old picture',
    });
    values['p.mediaId'] = 'another-image';
    values['p.alt.nl'] = 'Nieuw beeld';
    const { props } = propsFromForm(image.fields, postedValues(values), stored);
    expect(props['alt']).toEqual({ nl: 'Nieuw beeld' });
    // The same in a gallery row, whose image is replaced on its own.
    const gallery = examples.find((e) => e.type === 'gallery')!;
    const rows = gallery.props['images'] as Record<string, unknown>[];
    const both = {
      ...gallery.props,
      images: rows.map((r) => ({ ...r, alt: { nl: 'Rij', en: 'Row' } })),
    };
    const shown = formValues(gallery.fields, both, ['nl']);
    shown['p.images.0.mediaId'] = 'another-image';
    const read = propsFromForm(gallery.fields, postedValues(shown), both).props['images'] as {
      alt: unknown;
    }[];
    expect(read[0]!.alt).toEqual({ nl: 'Rij' });
    expect(read[1]!.alt).toEqual({ nl: 'Rij', en: 'Row' });
  });

  it('keeps a locale the form does not carry, and rich text it did not change', () => {
    const faq = examples.find((e) => e.name === 'faq-list')!;
    const withDe = structuredClone(faq.props) as {
      title: Record<string, string>;
      entries: { answer: Record<string, unknown> }[];
    };
    withDe.title['de'] = 'Häufige Fragen';
    const values = formValues(faq.fields, withDe, LOCALES);
    values['p.title.nl'] = 'Vragen';
    const { props } = propsFromForm(faq.fields, postedValues(values), withDe);
    expect(props['title']).toEqual({
      nl: 'Vragen',
      en: 'Frequently asked questions',
      de: 'Häufige Fragen',
    });
    // The answer documents are the very same objects: unchanged text is not re-parsed.
    const entries = props['entries'] as { answer: Record<string, unknown> }[];
    for (const l of LOCALES) expect(entries[0]!.answer[l]).toBe(withDe.entries[0]!.answer[l]);
  });

  describe('an emptied rich-text field (#130)', () => {
    const blank = { type: 'doc', content: [{ type: 'paragraph' }] };
    const faq = examples.find((e) => e.name === 'faq-list')!;
    const answers = (props: Record<string, unknown>) =>
      (props['entries'] as { answer: Record<string, unknown> }[]).map((e) => e.answer);

    it('is absent with the editor as without it, and the other locale stays', () => {
      const typed = formValues(faq.fields, faq.props, LOCALES);
      const noScript = { ...typed, 'p.entries.0.answer.en': '' };
      const script = { ...typed, 'p.entries.0.answer.en.editor': JSON.stringify(blank) };
      for (const values of [noScript, script]) {
        const { props, errors } = propsFromForm(faq.fields, postedValues(values), faq.props);
        expect(errors).toEqual([]);
        expect(answers(props)[0]).toEqual({ nl: answers(faq.props)[0]!['nl'] });
      }
    });

    it('counts spaces, a bare break and an empty list item as no words', () => {
      const docs = [
        { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '  ' }] }] },
        { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'hard_break' }] }] },
        {
          type: 'doc',
          content: [
            {
              type: 'bullet_list',
              content: [{ type: 'list_item', content: [{ type: 'paragraph' }] }],
            },
          ],
        },
      ];
      const typed = formValues(faq.fields, faq.props, LOCALES);
      for (const doc of docs) {
        const values = { ...typed, 'p.entries.0.answer.en.editor': JSON.stringify(doc) };
        expect(
          answers(propsFromForm(faq.fields, postedValues(values), faq.props).props)[0]
        ).toEqual({ nl: answers(faq.props)[0]!['nl'] });
      }
    });

    it('drops a row cleared with the editor on it, as without it', () => {
      const typed = formValues(faq.fields, faq.props, LOCALES);
      const values = {
        ...typed,
        'p.entries.1.question.nl': '',
        'p.entries.1.question.en': '',
        // The hidden textareas keep the words they loaded; the editors say they are gone.
        'p.entries.1.answer.nl.editor': JSON.stringify(blank),
        'p.entries.1.answer.en.editor': JSON.stringify(blank),
      };
      const { props } = propsFromForm(faq.fields, postedValues(values));
      expect(answers(props)).toHaveLength(answers(faq.props).length - 1);
    });

    it('keeps a row whose question is cleared while its editors are untouched, for core to refuse', () => {
      const typed = formValues(faq.fields, faq.props, LOCALES);
      const values = {
        ...typed,
        'p.entries.1.question.nl': '',
        'p.entries.1.question.en': '',
        // An untouched editor posts nothing: its textarea holds the only copy of the answer.
        'p.entries.1.answer.nl.editor': '',
        'p.entries.1.answer.en.editor': '',
      };
      const { props, errors } = propsFromForm(faq.fields, postedValues(values), faq.props);
      expect(errors).toEqual([]);
      expect(answers(props)).toEqual(answers(faq.props));
      expect(
        Block.safeParse({ id: 'x', type: 'faq', version: 2, props }).error?.issues[0]?.message
      ).toBe('i18n.localized.empty');
    });

    it('reads a blank document of an old revision as nothing typed, and a save removes it', () => {
      const rich = examples.find((e) => e.name === 'rich-text')!;
      const old = { content: { nl: (rich.props['content'] as { nl: unknown }).nl, en: blank } };
      const values = formValues(rich.fields, old, LOCALES);
      expect(values['p.content.en']).toBe('');
      const { props, errors } = propsFromForm(rich.fields, postedValues(values), old);
      expect(errors).toEqual([]);
      expect(props['content']).toEqual({ nl: old.content.nl });
    });

    it('leaves an only locale with nothing, which core refuses', () => {
      const rich = examples.find((e) => e.name === 'rich-text')!;
      const stored = { content: { nl: (rich.props['content'] as { nl: unknown }).nl } };
      const values = {
        ...formValues(rich.fields, stored, ['nl']),
        'p.content.nl.editor': JSON.stringify(blank),
      };
      const { props } = propsFromForm(rich.fields, postedValues(values), stored);
      expect(props['content']).toEqual({});
      expect(
        Block.safeParse({ id: 'x', type: 'rich-text', version: 1, props }).error?.issues[0]?.message
      ).toBe('i18n.localized.empty');
    });
  });

  it('removes a locale that is emptied, a list row that is cleared, and adds a typed row', () => {
    const faq = examples.find((e) => e.name === 'faq-list')!;
    const values = formValues(faq.fields, faq.props, LOCALES);
    expect(values['p.entries.rows']).toBe('3');
    values['p.title.en'] = '';
    values['p.entries.1.question.nl'] = '';
    values['p.entries.1.question.en'] = '';
    values['p.entries.1.answer.nl'] = '';
    values['p.entries.1.answer.en'] = '';
    values['p.entries.2.question.nl'] = 'Nieuw?';
    values['p.entries.2.answer.nl'] = 'Ja, **echt**.';
    const { props, errors } = propsFromForm(faq.fields, postedValues(values), faq.props);
    expect(errors).toEqual([]);
    expect(props['title']).toEqual({ nl: 'Veelgestelde vragen' });
    expect(
      (props['entries'] as { question: unknown; answer: unknown }[]).map((e) => e.question)
    ).toEqual([
      { nl: 'Wat gebeurt er met mijn gegevens?', en: 'What happens to my data?' },
      { nl: 'Nieuw?' },
    ]);
  });

  it('tells inherit, hide and own captions apart, and an override credit from none', () => {
    const image = examples.find((e) => e.name === 'image-wide-caption-credit')!;
    const values = formValues(image.fields, image.props, LOCALES);
    expect(values).toMatchObject({
      'p.caption.nl.mode': 'own',
      'p.caption.en.mode': 'hide',
      'p.credit.present': 'on',
    });
    values['p.caption.nl.mode'] = 'inherit';
    delete values['p.credit.present'];
    const { props } = propsFromForm(image.fields, postedValues(values), image.props);
    expect(props['caption']).toEqual({ en: '' });
    expect(props).not.toHaveProperty('credit');
  });

  it('reports rich text it cannot read and keeps the stored value', () => {
    const text = examples.find((e) => e.name === 'rich-text')!;
    const values = formValues(text.fields, text.props, LOCALES);
    values['p.content.en'] = '[open](https://example.org';
    const { props, errors } = propsFromForm(text.fields, postedValues(values), text.props);
    expect(errors).toEqual([
      { name: 'p.content.en', line: 1, message: 'editor.markdown.unclosed-link' },
    ]);
    expect(props).toEqual(text.props);
  });

  describe('a row rearranged in the form', () => {
    const cards = examples.find((e) => e.name === 'cards-filled-full')!;
    type Card = { title: Record<string, string> };
    const titles = (props: Record<string, unknown>) =>
      (props['cards'] as Card[]).map((c) => c.title);
    const bounds = { min: 2, max: 4 };
    // A form of one locale: the other one is only in the stored props.
    const nlOnly = () =>
      formValues(cards.fields, cards.props, ['nl'], { addButton: ['cards'] }) as Record<
        string,
        string
      >;
    const read = (values: Record<string, string | string[]>) =>
      propsFromForm(cards.fields, postedValues(values as Record<string, string>), cards.props);

    it('offers no spare row with an add button, and names the stored row of each', () => {
      const values = nlOnly();
      expect(values['p.cards.rows']).toBe('4');
      expect(values['p.cards.3.from']).toBe('3');
      expect(values).not.toHaveProperty('p.cards.4.from');
    });

    it('keeps the locale the form does not carry with a moved card', () => {
      const before = titles(cards.props);
      const { props, errors } = read(arrangeRows(nlOnly(), 'p.cards', 'later', 0, bounds));
      expect(errors).toEqual([]);
      expect(titles(props)).toEqual([before[1], before[0], before[2], before[3]]);
    });

    it('drops a removed card in every locale, and refuses to go below the minimum', () => {
      const before = titles(cards.props);
      const removed = arrangeRows(nlOnly(), 'p.cards', 'remove', 1, bounds);
      expect(removed['p.cards.rows']).toBe('3');
      expect(titles(read(removed).props)).toEqual([before[0], before[2], before[3]]);
      const two = arrangeRows(removed, 'p.cards', 'remove', 0, bounds);
      expect(arrangeRows(two, 'p.cards', 'remove', 0, bounds)['p.cards.rows']).toBe('2');
    });

    it('adds an empty card up to the maximum, which a save leaves out until it is typed in', () => {
      const removed = arrangeRows(nlOnly(), 'p.cards', 'remove', 3, bounds);
      const added = arrangeRows(removed, 'p.cards', 'add', 3, bounds);
      expect(added['p.cards.rows']).toBe('4');
      expect(added['p.cards.3.from']).toBe('');
      expect(arrangeRows(added, 'p.cards', 'add', 4, bounds)['p.cards.rows']).toBe('4');
      expect(titles(read(added).props)).toHaveLength(3);
      added['p.cards.3.title.nl'] = 'Nieuw';
      expect(titles(read(added).props)[3]).toEqual({ nl: 'Nieuw' });
    });

    it('reads a row of an older form, without `from`, as the stored row at its place', () => {
      const values = nlOnly();
      for (const k of Object.keys(values)) if (k.endsWith('.from')) delete values[k];
      expect(read(values).props).toEqual(cards.props);
    });
  });
});
