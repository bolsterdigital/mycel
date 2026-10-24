// Every registry block example is an editor fixture: adding a block cannot silently make the
// article editor lossy for its props, variants, ids or translations (ADR 020.5).
import { describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS, BLOCK_TYPES, Block, ContentDocument } from '@mycel/core';
import { fromArticleEditor, toArticleEditor } from './article-document.js';

const blocks = BLOCK_TYPES.flatMap((type) =>
  BLOCK_DEFINITIONS[type].examples.map((example, i) =>
    Block.parse({ id: `${type}-${i}`, type, version: 1, props: example.props })
  )
);
const base = (block: (typeof blocks)[number]) =>
  ContentDocument.parse({
    type: 'article',
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl: 'Artikel', en: 'Article' },
    blocks: [block],
    seo: {},
    access: block.type === 'paywall' ? { level: 'members', teaser: 'marker' } : { level: 'public' },
  });

describe('article editor document', () => {
  it.each(blocks.map((block) => [block.id, block] as const))(
    '%s survives a round trip in both locales',
    (_name, block) => {
      const document = base(block);
      for (const locale of ['nl', 'en']) {
        const editor = toArticleEditor(document, locale);
        expect(fromArticleEditor(document, locale, editor)).toEqual(document);
      }
    }
  );

  it('preserves order and refuses missing, duplicate and invented block ids', () => {
    const document = ContentDocument.parse({ ...base(blocks[0]!), blocks: [blocks[0], blocks[1]] });
    const editor = toArticleEditor(document, 'nl');
    expect(
      fromArticleEditor(document, 'nl', { ...editor, content: [...editor.content].reverse() })
        .blocks
    ).toEqual([blocks[1], blocks[0]]);
    expect(() =>
      fromArticleEditor(document, 'nl', { ...editor, content: editor.content.slice(1) })
    ).toThrow('missing');
    expect(() =>
      fromArticleEditor(document, 'nl', {
        ...editor,
        content: [editor.content[0], editor.content[0]],
      })
    ).toThrow('identity');
    expect(() =>
      fromArticleEditor(document, 'nl', {
        ...editor,
        content: [{ ...editor.content[0], attrs: { blockId: 'invented' } }, editor.content[1]],
      })
    ).toThrow('Unknown');
  });

  it('accepts a validated new quote card and a new prose block without changing other locales', () => {
    const document = base(blocks.find((block) => block.type === 'rich-text')!);
    const editor = toArticleEditor(document, 'nl');
    const quote = {
      id: 'imported-quote',
      type: 'quote',
      version: 1,
      props: {
        text: { nl: 'Een citaat' },
        attribution: { name: 'De bron' },
      },
    };
    editor.content.push({ type: 'mycelCard', attrs: { blockId: quote.id, newBlock: quote } });
    editor.content.push({
      type: 'mycelProse',
      attrs: {
        blockId: 'new-prose',
        newBlock: { id: 'new-prose', type: 'rich-text', version: 1, props: { content: {} } },
      },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Na het citaat' }] }],
    });
    const saved = fromArticleEditor(document, 'nl', editor);
    expect(saved.blocks.map((block) => block.id)).toEqual([
      document.blocks[0]!.id,
      quote.id,
      'new-prose',
    ]);
    expect(saved.blocks[0]).toEqual(document.blocks[0]);
    expect(saved.blocks[2]?.type).toBe('rich-text');
  });
});
