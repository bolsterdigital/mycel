// Every registry block example is an editor fixture: adding a block cannot silently make the
// article editor lossy for its props, variants, ids or translations (ADR 020.5).
import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { BLOCK_DEFINITIONS, BLOCK_TYPES, Block, ContentDocument } from '@mycel/core';
import { fromArticleEditor, toArticleEditor } from './article-document.js';
import { articleExtensions } from './article-extensions.js';

const editorSchema = getSchema(articleExtensions);
const throughEditorSchema = (document: ContentDocument, locale: string) =>
  editorSchema.nodeFromJSON(toArticleEditor(document, locale)).toJSON();

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
        const editor = throughEditorSchema(document, locale);
        expect(fromArticleEditor(document, locale, editor)).toEqual(document);
      }
    }
  );

  it.each([undefined, 1, 3])(
    'keeps a numbered list start of %s, marks, block id and the other locale through TipTap',
    (start) => {
      const prose = blocks.find((block) => block.type === 'rich-text')!;
      const document = ContentDocument.parse({
        ...base(prose),
        blocks: [
          {
            ...prose,
            props: {
              content: {
                nl: {
                  type: 'doc',
                  content: [
                    {
                      type: 'ordered_list',
                      ...(start === undefined ? {} : { attrs: { start } }),
                      content: [
                        {
                          type: 'list_item',
                          content: [
                            {
                              type: 'paragraph',
                              content: [
                                { type: 'text', text: 'Derde', marks: [{ type: 'bold' }] },
                                { type: 'text', text: ' punt' },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
                en: {
                  type: 'doc',
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'Third point' }] },
                  ],
                },
              },
            },
          },
        ],
      });
      const actual = throughEditorSchema(document, 'nl');
      expect(actual.content[0]?.content?.[0]?.attrs).toEqual({
        start: start ?? 1,
        type: null,
        mycelExplicitStart: start === 1 ? true : null,
      });
      expect(fromArticleEditor(document, 'nl', actual)).toEqual(document);
      actual.content[0]!.content![0]!.content![0]!.content![0]!.content![0]!.text = 'Gewijzigd';
      const edited = fromArticleEditor(document, 'nl', actual);
      expect(edited.blocks[0]?.id).toBe(document.blocks[0]?.id);
      const editedProse = edited.blocks[0];
      const originalProse = document.blocks[0];
      if (editedProse?.type !== 'rich-text' || originalProse?.type !== 'rich-text')
        throw new Error('Expected rich-text block');
      expect(editedProse.props.content.en).toEqual(originalProse.props.content.en);
      const editedList = editedProse.props.content.nl?.content[0];
      if (editedList?.type !== 'ordered_list') throw new Error('Expected ordered list');
      expect(editedList.attrs).toEqual(start === undefined ? undefined : { start });
      actual.content[0]!.content![0]!.attrs.unexpected = true;
      expect(() => fromArticleEditor(document, 'nl', actual)).toThrow('Unrecognized key');
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
