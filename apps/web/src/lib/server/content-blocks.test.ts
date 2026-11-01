// The block summaries and the mapping of core's refusals onto block form fields (TODO #11 B).
import { describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS, Block, UseCaseError } from '@mycel/core';
import { fieldIssues, previewOf, summaryOf, textRestOf } from './content-blocks.js';

const example = (type: keyof typeof BLOCK_DEFINITIONS, n = 0) =>
  Block.parse({
    id: 'b',
    type,
    version: BLOCK_DEFINITIONS[type].version,
    props: BLOCK_DEFINITIONS[type].examples[n]!.props,
  });

describe('summaryOf', () => {
  it('names a block by its first text in the locale, rich text and list rows included', () => {
    expect(summaryOf(example('hero'), 'en')).toBe('Clean air for everyone');
    expect(summaryOf(example('rich-text'), 'nl')).toBe(
      'Meer over ons werk staat in het jaarverslag'
    );
    expect(summaryOf(example('faq'), 'nl')).toBe('Veelgestelde vragen');
    expect(summaryOf(example('form'), 'nl')).toBe('');
  });
});

describe('textRestOf', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Kop <b>' }] },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'naar buiten',
            marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://example.org/' } }],
          },
          {
            type: 'text',
            text: 'noot',
            marks: [{ type: 'footnote_reference', attrs: { text: 'De <noot>' } }],
          },
        ],
      },
    ],
  };
  const rich = (content: unknown) =>
    Block.parse({ id: 'b', type: 'rich-text', version: 1, props: { content } });

  it('sets rich text as the page does, without a link, a heading or an id', () => {
    const view = textRestOf(rich({ nl: doc }), 'nl', 'b.b.');
    if (view?.kind !== 'rich-text') throw new Error('no rich-text view');
    expect(view.html).toContain('<p data-heading="1">Kop &lt;b&gt;</p>');
    expect(view.html).toContain('<span data-link><strong>naar buiten</strong></span>');
    expect(view.html).toContain('<li>De &lt;noot&gt;</li>');
    expect(view.html).not.toMatch(/<a\b|<h[1-6]|\bid=|href/);
  });

  it('reads the other locale when this one is absent, and nothing for an empty text', () => {
    expect(textRestOf(rich({ en: doc }), 'nl', 'b.b.')?.kind).toBe('rich-text');
    expect(
      textRestOf(rich({ nl: { type: 'doc', content: [{ type: 'paragraph' }] } }), 'nl', 'b.b.')
    ).toBe(null);
  });

  it('names a heading by its text and field, and a quote by what the page prints', () => {
    expect(textRestOf(example('heading'), 'en', 'b.b.')).toEqual({
      kind: 'heading',
      text: 'Who we are',
      from: 'b.b.p.text.en',
    });
    const quote = Block.parse({
      id: 'b',
      type: 'quote',
      version: 1,
      props: {
        text: { nl: 'Dit is het.' },
        attribution: { name: 'Sam', role: { nl: 'Voorzitter' }, url: 'https://example.org/' },
      },
    });
    expect(textRestOf(quote, 'nl', 'b.b.')).toMatchObject({
      kind: 'quote',
      text: 'Dit is het.',
      by: 'Sam, Voorzitter, https://example.org/',
      variant: 'blockquote',
    });
  });

  it('sets a callout with its kind, title and inert body, and each answer of an FAQ', () => {
    const callout = textRestOf(
      Block.parse({
        id: 'b',
        type: 'callout',
        version: 1,
        props: { variant: 'warning', title: { nl: 'Let <op>' }, body: { nl: doc } },
      }),
      'nl',
      'b.b.'
    );
    expect(callout).toMatchObject({
      kind: 'callout',
      variant: 'warning',
      title: 'Let <op>',
      titleFrom: 'b.b.p.title.nl',
      proseFrom: 'b.b.p.body.nl.editor',
    });
    if (callout?.kind !== 'callout') throw new Error('no callout view');
    expect(callout.html).not.toMatch(/<a\b|<h[1-6]|\bid=|href/);

    const faq = textRestOf(example('faq', 1), 'nl', 'b.b.');
    if (faq?.kind !== 'faq') throw new Error('no faq view');
    expect(faq.variant).toBe('accordion');
    expect(faq.list).toBe('b.b.p.entries');
    expect(faq.entries[0]).toMatchObject({
      from: 'b.b.p.entries.0.question.nl',
      proseFrom: 'b.b.p.entries.0.answer.nl.editor',
    });
    for (const entry of faq.entries) expect(entry.html).not.toMatch(/<a\b|href/);
  });

  it('gives a CTA both of its action places, also when only one is filled', () => {
    const cta = textRestOf(example('cta'), 'nl', 'b.b.');
    if (cta?.kind !== 'cta') throw new Error('no cta view');
    expect(cta.title).toBe('Doe mee');
    expect(cta.actions).toHaveLength(2);
    expect(cta.actions[1]).toEqual({ label: '', from: 'b.b.p.actions.1.label.nl' });
  });

  it('has no view for a type that still shows the summary', () => {
    expect(textRestOf(example('video-embed'), 'nl', 'b.b.')).toBe(null);
  });
});

describe('previewOf', () => {
  it('shows an image with its caption, a heading by its text and an FAQ by its questions', () => {
    const image = previewOf(example('image', 1), 'nl');
    expect(image.mediaId).toBe(BLOCK_DEFINITIONS.image.examples[1]!.props.mediaId);
    expect(image.text).toBe('Ruim tweeduizend mensen kwamen af op de oproep.');
    expect(previewOf(example('heading'), 'nl')).toEqual({
      text: summaryOf(example('heading'), 'nl'),
      mediaId: null,
      entries: [],
    });
    const faq = previewOf(example('faq'), 'nl');
    expect(faq.text).toBe('Veelgestelde vragen');
    expect(faq.entries.length).toBeGreaterThan(1);
    expect(faq.entries.every((q) => q.length > 0 && q.length <= 80)).toBe(true);
  });

  it('finds the image inside a group, as the hero has it', () => {
    expect(previewOf(example('hero', 1), 'en').mediaId).toEqual(expect.any(String));
  });
});

describe('fieldIssues', () => {
  it('maps paths in the document, in update and in insert onto form names', () => {
    const e = new UseCaseError('invalid_input', 'x', [
      { path: 'blocks.3.props.title.nl', message: 'i18n.localized.empty' },
      { path: 'blocks.2.props.title.nl', message: 'i18n.localized.empty' },
      { path: 'block.props.text', message: 'content.link.unsafe' },
      { path: 'props', message: 'content.hero.image-required' },
      { path: 'blocks', message: 'content.blocks.adjacent-rich-text' },
    ]);
    expect(fieldIssues(e, 3)).toEqual([
      { name: 'p.title.nl', copy: 'admin.block.issue.required' },
      { name: '', copy: 'admin.block.issue.required' },
      { name: 'p.text', copy: 'admin.block.issue.unsafeLink' },
      { name: '', copy: 'admin.block.issue.heroImage' },
      { name: '', copy: 'admin.block.issue.adjacentText' },
    ]);
  });
});
