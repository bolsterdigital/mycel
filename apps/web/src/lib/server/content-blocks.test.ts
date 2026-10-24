// The block summaries and the mapping of core's refusals onto block form fields (TODO #11 B).
import { describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS, Block, UseCaseError } from '@mycel/core';
import { fieldIssues, summaryOf } from './content-blocks.js';

const example = (type: keyof typeof BLOCK_DEFINITIONS, n = 0) =>
  Block.parse({ id: 'b', type, version: 1, props: BLOCK_DEFINITIONS[type].examples[n]!.props });

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

describe('fieldIssues', () => {
  it('maps paths in the document, in set_props and in insert onto form names', () => {
    const e = new UseCaseError('invalid_input', 'x', [
      { path: 'blocks.3.props.title.nl', message: 'i18n.localized.empty' },
      { path: 'blocks.2.props.title.nl', message: 'i18n.localized.empty' },
      { path: 'block.props.text', message: 'content.link.unsafe:x' },
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
