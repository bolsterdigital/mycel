// The block summaries and the mapping of core's refusals onto block form fields (TODO #11 B).
import { describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS, Block, UseCaseError } from '@mycel/core';
import { fieldIssues, previewOf, summaryOf } from './content-blocks.js';

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
  it('maps paths in the document, in set_props and in insert onto form names', () => {
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
