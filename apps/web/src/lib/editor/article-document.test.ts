// Every registry block example is an editor fixture: adding a block cannot silently make the
// article editor lossy for its props, variants, ids or translations (ADR 020.5).
import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import {
  BLOCK_DEFINITIONS,
  BLOCK_TYPES,
  Block,
  ContentDocument,
  readinessIssues,
} from '@mycel/core';
import {
  fromArticleEditor,
  toArticleEditor,
  toTiptap,
  fromTiptap,
  removedArticleCards,
} from './article-document.js';
import { articleExtensions, proseExtensions } from './article-extensions.js';

const editorSchema = getSchema(articleExtensions);
const throughEditorSchema = (document: ContentDocument, locale: string) =>
  editorSchema.nodeFromJSON(toArticleEditor(document, locale)).toJSON();

const blocks = BLOCK_TYPES.flatMap((type) =>
  BLOCK_DEFINITIONS[type].examples.map((example, i) =>
    Block.parse({
      id: `${type}-${i}`,
      type,
      version: BLOCK_DEFINITIONS[type].version,
      props: example.props,
    })
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

it('the inline page schema keeps all prose at the document root without article wrappers', () => {
  const content = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph' }] },
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Section' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Last paragraph' }] },
    ],
  };
  const schema = getSchema(proseExtensions);
  const through = schema.nodeFromJSON(toTiptap(content));
  through.check();
  expect(fromTiptap(through.toJSON())).toEqual(content);
  expect(schema.nodes.mycelProse).toBeUndefined();
  expect(schema.nodes.mycelCard).toBeUndefined();
});

describe('article editor document', () => {
  it.each(blocks.map((block) => [block.id, block] as const))(
    '%s survives a round trip in both locales',
    (_name, block) => {
      const document = base({ ...block, name: { nl: 'Interne naam', en: 'Internal name' } });
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

  it('accepts only explicit card removal, clears it on undo, and refuses unexplained loss', () => {
    const quote = blocks.find((block) => block.type === 'quote')!;
    const document = base(quote);
    const before = toArticleEditor(document, 'nl');
    const after = { type: 'doc' as const, content: [] };
    const removedCardIds = removedArticleCards(before, after, [], true);
    expect(removedCardIds).toEqual([quote.id]);
    expect(fromArticleEditor(document, 'nl', { ...after, removedCardIds }).blocks).toEqual([]);
    expect(removedArticleCards(after, before, removedCardIds, true)).toEqual([]);
    expect(fromArticleEditor(document, 'nl', before)).toEqual(document);
    expect(removedArticleCards(before, after, [], false)).toEqual([]);
    expect(() => fromArticleEditor(document, 'nl', after)).toThrow('missing');
    expect(() =>
      fromArticleEditor(document, 'nl', { ...after, removedCardIds: ['unknown'] })
    ).toThrow('Invalid card removal');
    expect(() => fromArticleEditor(document, 'nl', { ...after, removedCardIds: 'all' })).toThrow(
      'Invalid card removal'
    );
    const prose = blocks.find((block) => block.type === 'rich-text')!;
    expect(() =>
      fromArticleEditor(base(prose), 'nl', { ...after, removedCardIds: [prose.id] })
    ).toThrow('Invalid card removal');
    expect(() => fromArticleEditor(base(prose), 'nl', after)).toThrow('missing');
  });

  it('takes the teaser along when the only paywall is removed', () => {
    const paywall = blocks.find((block) => block.type === 'paywall')!;
    const document = base(paywall);
    const after = { type: 'doc' as const, content: [], removedCardIds: [paywall.id] };
    const saved = fromArticleEditor(document, 'nl', after);
    expect(saved.blocks).toEqual([]);
    expect(saved.access).toEqual({ level: 'members', teaser: 'lead' });
    expect(fromArticleEditor(document, 'nl', toArticleEditor(document, 'nl'))).toEqual(document);
  });

  it('normalizes prose brought together by a removed card without losing translations', () => {
    const prose = blocks.find((block) => block.type === 'rich-text')!;
    const quote = blocks.find((block) => block.type === 'quote')!;
    const second = { ...prose, id: 'second-prose' };
    const document = ContentDocument.parse({ ...base(prose), blocks: [prose, quote, second] });
    const editor = toArticleEditor(document, 'nl');
    const saved = fromArticleEditor(document, 'nl', {
      ...editor,
      content: editor.content.filter((node) => node.attrs.blockId !== quote.id),
      removedCardIds: [quote.id],
    });
    expect(saved.blocks).toHaveLength(1);
    expect(saved.blocks[0]?.id).toBe(prose.id);
    if (prose.type !== 'rich-text' || saved.blocks[0]?.type !== 'rich-text')
      throw new Error('prose');
    for (const locale of Object.keys(prose.props.content))
      expect(saved.blocks[0].props.content[locale]?.content).toEqual([
        ...prose.props.content[locale]!.content,
        ...prose.props.content[locale]!.content,
      ]);
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

  // #142: an emptied block. Readiness is the third regression: the two cases that used to end in a
  // blank document or a refused publish.
  describe('an emptied prose block', () => {
    const words = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const blankNode = [{ type: 'paragraph' }];
    const quote = (id: string) =>
      Block.parse({
        id,
        type: 'quote',
        version: 1,
        props: { text: { nl: 'Citaat' }, attribution: { name: 'Bron' } },
      });
    const article = (blocks: unknown[], locales = ['nl', 'en']) =>
      ContentDocument.parse({
        type: 'article',
        defaultLocale: 'nl',
        locales,
        title: Object.fromEntries(locales.map((l) => [l, 'Artikel'])),
        blocks,
        seo: {},
        access: { level: 'public' },
      });
    const prose = (content: Record<string, unknown>) =>
      Block.parse({ id: 'prose', type: 'rich-text', version: 1, props: { content } });
    const emptied = (document: ContentDocument, locale: string) => {
      const editor = toArticleEditor(document, locale);
      for (const node of editor.content)
        if (node.type === 'mycelProse') node.content = blankNode as never;
      return fromArticleEditor(document, locale, editor);
    };

    it('loses its locale while another has words, so that locale shows through', () => {
      const document = article([prose({ nl: words('Nederlands'), en: words('English') })]);
      const saved = emptied(document, 'en');
      const content = (saved.blocks[0]!.props as { content: Record<string, unknown> }).content;
      expect(content).toEqual({ nl: words('Nederlands') });
      expect(readinessIssues(saved, 'nl')).toEqual([]);
      expect(readinessIssues(saved, 'en').map((i) => i.message)).toEqual([
        'content.publish.missing-translation',
      ]);
      const reopened = toArticleEditor(saved, 'en').content[0]!;
      expect(reopened.attrs.showThrough).toEqual({ locale: 'nl', text: 'Nederlands' });
      // The hint is not the value: the editor holds nothing and saving it again changes nothing.
      expect(reopened.content).toEqual(blankNode);
      expect(fromArticleEditor(saved, 'en', toArticleEditor(saved, 'en'))).toEqual(saved);
    });

    it('goes in the only locale it has, and that article publishes', () => {
      const document = article(
        [quote('one'), prose({ nl: words('Wordt leeg') }), quote('two')],
        ['nl']
      );
      const saved = emptied(document, 'nl');
      expect(saved.blocks.map((block) => block.id)).toEqual(['one', 'two']);
      expect(readinessIssues(saved, 'nl')).toEqual([]);
    });

    it('goes when only blank documents are left, so an old blank cannot hold it', () => {
      const document = article([
        prose({ nl: { type: 'doc', content: blankNode }, en: words('x') }),
      ]);
      expect(emptied(document, 'en').blocks).toEqual([]);
    });

    it('a new block nobody wrote in is not stored', () => {
      const document = article([quote('one')]);
      const editor = toArticleEditor(document, 'nl');
      editor.content.push({
        type: 'mycelProse',
        attrs: {
          blockId: 'typed',
          newBlock: { id: 'typed', type: 'rich-text', version: 1, props: { content: {} } },
        },
        content: blankNode as never,
      });
      expect(fromArticleEditor(document, 'nl', editor).blocks.map((b) => b.id)).toEqual(['one']);
    });

    it('keeps the empty lines inside a block with words', () => {
      const content = {
        type: 'doc',
        content: [...words('Een').content, { type: 'paragraph' }, ...words('Twee').content],
      };
      const document = article([prose({ nl: words('Oud') })], ['nl']);
      const editor = toArticleEditor(document, 'nl');
      editor.content[0]!.content = content.content as never;
      const saved = fromArticleEditor(document, 'nl', editor);
      expect((saved.blocks[0]!.props as { content: unknown }).content).toEqual({ nl: content });
    });

    it('shows the default locale first, and shortens what it shows', () => {
      const long = 'woord '.repeat(100).trim();
      const document = article(
        [prose({ de: words('Deutsch'), nl: words(long) })],
        ['nl', 'en', 'de']
      );
      const through = toArticleEditor(document, 'en').content[0]!.attrs.showThrough!;
      expect(through.locale).toBe('nl');
      expect(through.text.length).toBeLessThanOrEqual(201);
      expect(through.text.endsWith('…')).toBe(true);
    });
  });
});
