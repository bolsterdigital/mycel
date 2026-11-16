// Which blocks a menu anchor can land on (`shown.ts`), against every example of every block type
// in `BLOCK_DEFINITIONS`. Nothing resolves here: no form, no media, no item, no campaign, no
// person. The blocks that then show nothing are the ones the menu editor warns about
// (lib/server/navigation/anchors.ts); `blocks.conformance.test.ts` checks that every example with
// its references resolved does render its anchor.
import { describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS, BLOCK_TYPES, Block, projectBlock } from '@mycel/core';
import { resolveDocument, type ResolveSource } from './resolve.js';
import { shownBlockIds } from './shown.js';

const examples = BLOCK_TYPES.flatMap((type) =>
  BLOCK_DEFINITIONS[type].examples.map((e) => ({
    name: e.name,
    block: Block.parse({
      id: e.name,
      type,
      version: BLOCK_DEFINITIONS[type].version,
      props: e.props,
    }),
  }))
);

describe('a menu anchor lands only on a block that renders', () => {
  const nothing: ResolveSource = {
    form: async () => null,
    media: async () => null,
    itemPath: async () => null,
  };
  it('names exactly the examples that render no element', async () => {
    const empty: string[] = [];
    for (const { name, block } of examples) {
      const model = await resolveDocument(
        nothing,
        { locale: 'nl', title: 'Titel', blocks: [projectBlock(block, 'nl')] },
        { base: '', fallbackLocale: 'nl' }
      );
      if (!shownBlockIds(model).has(block.id)) empty.push(name);
    }
    // The boundary renders nothing anyway; a hero, a call to action and cards keep their text.
    expect(empty).toEqual([
      'signup-form',
      'paywall',
      'image-content',
      'image-wide-caption-credit',
      'image-full-decorative',
      'image-float-left',
      'image-float-right',
      'people-grid-selection',
      'people-grid-group',
      'people-grid-compact',
      'file-download-one',
      'file-download-titled',
      'gallery-grid',
      'gallery-row-content',
      'gallery-grid-full',
      'audio-plain',
      'audio-transcript',
      'form-default',
      'form-card-wide',
      'form-full',
      'campaign-card-compact',
      'campaign-card-full-wide',
      'campaign-card-compact-full',
      // An overview that finds nothing renders nothing, like an empty grid.
      'overview-articles-cards',
      'overview-articles-list',
      'overview-pages-full',
    ]);
  });
});
