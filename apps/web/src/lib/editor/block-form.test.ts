// The generated block forms round-trip every registry example (brief content-editor § B): the
// form of the stored props reads back as the same props, on top of the stored block and from
// nothing (a new block), and an edit in one locale leaves the others as they were.

import { describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS, BLOCK_TYPES, Block } from '@mycel/core';
import { formValues, postedValues, propsFromForm } from './block-form.js';

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
});
