// The one form of the edit screen (#66 PR 2): every block's fields under its own prefix read
// back as its stored props, a block the form does not carry or the one being removed keeps its
// props, a pending block needs a known type and place, and core's issue paths land on the field.

import { describe, expect, it } from 'vitest';
import {
  BLOCK_DEFINITIONS,
  BLOCK_TYPES,
  Block,
  ContentDocument,
  INSERTABLE_BLOCK_TYPES,
  UseCaseError,
  type BlockField,
} from '@mycel/core';
import { formValues, postedValues } from '#lib/editor/block-form.js';
import { issueCopy } from './content-blocks.js';
import { ISSUES } from './edit-copy.js';
import {
  formDocument,
  blockIssueField,
  blockIssues,
  blockRefusalIssues,
  documentFieldIssues,
  formFieldOf,
  blockPrefix,
  blocksFrom,
  pendingBlock,
  pendingFields,
  pendingProps,
  pendingUntouched,
  pendingView,
  droppedMedia,
  insertQuery,
} from './edit-form.js';

const LOCALES = ['nl', 'en'];

const blocks = BLOCK_TYPES.flatMap((type, i) =>
  BLOCK_DEFINITIONS[type].examples
    .slice(0, 1)
    .map((e) =>
      Block.parse({ id: `b${i}`, type, version: BLOCK_DEFINITIONS[type].version, props: e.props })
    )
);

/** The form of every block, each under its prefix, as one post. */
function formOf(list: readonly Block[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of list)
    for (const [k, v] of Object.entries(
      formValues(BLOCK_DEFINITIONS[b.type].fields, b.props as Record<string, unknown>, LOCALES)
    ))
      out[`${blockPrefix(b.id)}${k}`] = v;
  return out;
}

/**
 * One input per control of an empty form under `name`: a word in a text, another option in a
 * choice, a ticked box, one more row in a list. `empty` is the empty view, for row counts and
 * the selected options.
 */
function inputsOf(
  fields: readonly BlockField[],
  name: string,
  empty: Record<string, string>,
  locales: readonly string[]
): [string, string][] {
  const other = (n: string, options: readonly string[]) =>
    [n, options.find((o) => o !== empty[n])!] as [string, string];
  return fields.flatMap((f): [string, string][] => {
    const n = `${name}.${f.key}`;
    switch (f.kind) {
      case 'text':
        return f.localized ? locales.map((l) => [`${n}.${l}`, 'x']) : [[n, 'x']];
      case 'caption':
        return locales.flatMap((l): [string, string][] => [
          [`${n}.${l}`, 'x'],
          other(`${n}.${l}.mode`, ['inherit', 'hide', 'own']),
        ]);
      case 'rich-text':
        return locales.map((l) => [`${n}.${l}`, 'x']);
      case 'media':
      case 'reference':
      case 'date':
        return [[n, 'x']];
      case 'choice':
        return [other(n, f.options)];
      case 'boolean':
        return [[n, 'on']];
      case 'actions':
        return Array.from({ length: f.max }, (_, i): [string, string][] => [
          ...locales.map((l): [string, string] => [`${n}.${i}.label.${l}`, 'x']),
          [`${n}.${i}.target`, 'url'],
          [`${n}.${i}.url`, 'x'],
        ]).flat();
      case 'group':
        return [
          ...(f.optional === 'omit' ? [[`${n}.present`, 'on'] as [string, string]] : []),
          ...inputsOf(f.fields, n, empty, locales),
        ];
      case 'list': {
        const rows = Number(empty[`${n}.rows`]);
        return [
          [`${n}.rows`, String(rows + 1)],
          ...Array.from({ length: rows }, (_, i) =>
            inputsOf(f.fields, `${n}.${i}`, empty, locales)
          ).flat(),
        ];
      }
    }
  });
}

describe('the one edit form', () => {
  it('does not count an empty name field as a change to an unnamed block', () => {
    const blocks = [
      { id: 'a', type: 'heading' as const, version: 1 as const, props: { text: { nl: 'Kop' } } },
    ];
    expect(
      blocksFrom(blocks, postedValues({ ...formOf(blocks), 'b.a.name.nl': ' ' })).blocks
    ).toEqual(blocks);
  });

  it('patches a block name without dropping other locales or unopened block metadata', () => {
    const blocks = [
      {
        id: 'a',
        type: 'heading' as const,
        version: 1 as const,
        props: { text: { nl: 'Kop' } },
        name: { nl: 'Oud', en: 'Old' },
      },
    ];
    const form = { ...formOf(blocks), 'b.a.name.nl': 'Nieuw' };
    expect(blocksFrom(blocks, postedValues(form)).blocks[0]!.name).toEqual({
      nl: 'Nieuw',
      en: 'Old',
    });
    expect(blocksFrom(blocks, postedValues({})).blocks).toEqual(blocks);
  });

  it('reads every block back as stored when nothing was typed', () => {
    expect(blocksFrom(blocks, postedValues(formOf(blocks)))).toEqual({ blocks, errors: [] });
  });

  it('uses the description choice for image forms without normalising gallery or legacy hero', () => {
    const image = blocks.find((b) => b.type === 'image')!;
    const gallery = blocks.find((b) => b.type === 'gallery')!;
    const hero = blocks.find((b) => b.type === 'hero')!;
    const form = formOf([image, gallery, hero]);
    const prefix = blockPrefix(image.id);
    form[`${prefix}imageAltShown`] = '1';
    form[`${prefix}p.alt.nl`] = '';
    form[`${prefix}p.alt.en`] = '';
    const read = blocksFrom([image, gallery, hero], postedValues(form));
    expect(read.blocks[0]?.props).toMatchObject({ decorative: true, alt: null });
    expect(read.blocks[1]).toEqual(gallery);
    expect(read.blocks[2]).toEqual(hero);
    const p = pendingBlock('image', 'end', null, [])!;
    const empty = { ...pendingView(p, ['nl']).values, 'new.imageAltShown': '1' };
    expect(pendingUntouched(p, postedValues(empty), ['nl'])).toBe(true);
    expect(pendingProps(p, postedValues(empty)).props).toMatchObject({
      decorative: true,
      alt: null,
    });
  });

  it('changes one block and leaves the others and the skipped one as stored', () => {
    const heading = blocks.find((b) => b.type === 'heading')!;
    const form = formOf(blocks);
    form[`${blockPrefix(heading.id)}p.text.nl`] = 'Nieuwe kop';
    const other = blocks.find((b) => b.type !== 'heading')!;
    for (const k of Object.keys(form))
      if (k.startsWith(blockPrefix(other.id))) form[k] = 'x'.repeat(3);
    const read = blocksFrom(blocks, postedValues(form), other.id);
    expect(read.errors).toEqual([]);
    expect(read.blocks.find((b) => b.id === other.id)).toBe(other);
    const changed = read.blocks.find((b) => b.id === heading.id)!;
    expect((changed.props as { text: Record<string, string> }).text.nl).toBe('Nieuwe kop');
    for (const b of read.blocks)
      if (b.id !== heading.id) expect(b).toEqual(blocks.find((x) => x.id === b.id));
  });

  it('keeps a block the form has no field of', () => {
    const form = formOf(blocks.slice(1));
    expect(blocksFrom(blocks, postedValues(form)).blocks[0]).toBe(blocks[0]);
  });

  it('accepts a pending block only with a known type and place', () => {
    const ids = ['a', 'b'];
    expect(pendingBlock('heading', 'after', 'a', ids)).toEqual({
      type: 'heading',
      place: { after: 'a' },
    });
    expect(pendingBlock('heading', 'end', null, ids)).toEqual({
      type: 'heading',
      place: { at: 'end' },
    });
    expect(pendingBlock('heading', 'before', 'gone', ids)).toBeNull();
    expect(pendingBlock('nope', 'end', null, ids)).toBeNull();
    // New content gets no hero (ADR 025 rule 4): `?insert=hero` makes nothing.
    expect(pendingBlock('hero', 'end', null, ids)).toBeNull();
    expect(pendingBlock('heading', 'middle', 'a', ids)).toBeNull();
    expect(pendingBlock(null, 'end', null, ids)).toBeNull();
  });

  it('carries a pending block and its typed props through a post', () => {
    const p = pendingBlock('heading', 'before', 'a', ['a'])!;
    const hidden = pendingFields(p);
    expect(
      pendingBlock(hidden['new.type']!, hidden['new.place']!, hidden['new.anchor']!, ['a'])
    ).toEqual(p);
    const read = pendingProps(p, postedValues({ ...hidden, 'new.p.text.nl': 'Kop' }));
    expect(read.errors).toEqual([]);
    expect(read.props).toMatchObject({ text: { nl: 'Kop' } });
  });

  it('puts core issues on the field of the block they are about', () => {
    const e = new UseCaseError('invalid_input', 'bad', [
      { path: 'document.blocks.1.props.text.nl', message: 'x' },
      { path: 'block.props.text.en', message: 'y' },
      { path: 'document.title.nl', message: 'z' },
    ]);
    expect(blockIssues(e, [{ id: 'a' }, { id: 'b' }])).toEqual([
      { name: 'b.b.p.text.nl', message: 'x' },
      { name: 'new.p.text.en', message: 'y' },
    ]);
  });

  it("reads a block action's issue, which starts at the document root, the same way", () => {
    const e = new UseCaseError('invalid_input', 'bad', [
      { path: 'access.teaser', message: 'content.access.marker-needs-one-paywall' },
      { path: 'blocks.0.props.text', message: 'x' },
    ]);
    expect(documentFieldIssues(e)).toEqual([
      { name: 'teaser', message: 'content.access.marker-needs-one-paywall' },
    ]);
  });

  it('names a refused block operation on the document, or on the block as a whole', () => {
    const refusal = (path: string, message: string) =>
      blockRefusalIssues(new UseCaseError('invalid_input', 'bad', [{ path, message }]));
    expect(refusal('access.teaser', 'content.access.marker-needs-one-paywall')).toEqual([
      { name: 'teaser', copy: 'admin.content.error.marker' },
    ]);
    // A join of text in different locales has no field: the summary names it without a link.
    expect(refusal('blockId', 'content.blocks.merge-ambiguous')).toEqual([
      { name: '', copy: 'admin.block.issue.mergeAmbiguous' },
    ]);
    // A key without copy of its own keeps the general sentence, as does any other refusal.
    expect(refusal('blockId', 'content.blocks.unknown')).toEqual([]);
    expect(blockRefusalIssues(new UseCaseError('conflict', 'later', []))).toEqual([]);
  });

  it('points a refusal of a whole localised field at the control on screen', () => {
    const values = {
      'b.a.p.text.nl': '',
      'b.a.p.text.en': '',
      'b.a.p.body.nl.editor': '{}',
      'b.a.p.width': 'full',
    };
    expect(formFieldOf('b.a.p.text', values)).toBe('b.a.p.text.nl');
    expect(formFieldOf('b.a.p.width', values)).toBe('b.a.p.width');
    expect(formFieldOf('b.a.p.body', values)).toBe('b.a.p.body');
    expect(formFieldOf('b.a.p.gone', values)).toBe('b.a.p.gone');
    const list = { 'new.p.cards.rows': '2', 'new.p.cards.0.title.nl': 'Een' };
    expect(formFieldOf('new.p.cards', list)).toBe('new.p.cards.0.title.nl');
    // The summary names the list, and still links to its first control.
    expect(blockIssueField('new.p.cards', list)).toEqual({
      name: 'new.p.cards.0.title.nl',
      list: 'new.p.cards',
    });
    expect(blockIssueField('b.a.p.text', values)).toEqual({ name: 'b.a.p.text.nl' });
  });

  // Choosing another block replaces one nothing was typed into, of every type, in the one
  // locale the form shows; a typed word, a switched choice or a picked file keeps it.
  it('tells an untouched pending block from one with input', () => {
    for (const type of INSERTABLE_BLOCK_TYPES) {
      const p = pendingBlock(type, 'end', null, [])!;
      const shown = pendingView(p, ['nl']);
      const post = { ...shown.hidden, ...shown.values };
      expect(pendingUntouched(p, postedValues(post), LOCALES), type).toBe(true);
      // With JavaScript a rich-text field also posts its editor's blank document.
      const blank = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });
      const enhanced = { ...post };
      for (const f of BLOCK_DEFINITIONS[type].fields)
        if (f.kind === 'rich-text') enhanced[`new.p.${f.key}.nl.editor`] = blank;
      expect(pendingUntouched(p, postedValues(enhanced), LOCALES), type).toBe(true);
    }
    const cards = pendingBlock('cards', 'end', null, [])!;
    const empty = pendingView(cards, ['nl']);
    const typed = { ...empty.values, 'new.p.cards.1.title.nl': 'Tweede' };
    expect(pendingUntouched(cards, postedValues(typed), LOCALES)).toBe(false);
    const switched = { ...empty.values, 'new.p.width': 'full' };
    expect(pendingUntouched(cards, postedValues(switched), LOCALES)).toBe(false);
    const image = pendingBlock('image', 'end', null, [])!;
    const picked = { ...pendingView(image, ['nl']).values, 'new.p.mediaId': 'm1' };
    expect(pendingUntouched(image, postedValues(picked), LOCALES)).toBe(false);
  });

  // Images dropped on the screen: their ids reach the pending block through the query, each
  // once and valid, and the block starts with the pictures and without alt text.
  it('starts a pending image or gallery with the dropped images', () => {
    const [a, b] = ['0b9e2b4e-1a50-4c1d-9a65-6b1fb1d7a001', '0b9e2b4e-1a50-4c1d-9a65-6b1fb1d7a002'];
    expect(droppedMedia(`${a},x,${a},${b}`)).toEqual([a, b]);
    expect(droppedMedia(null)).toEqual([]);
    expect(droppedMedia(Array.from({ length: 30 }, () => a).join(','))).toHaveLength(1);
    const form = new FormData();
    form.set('insertMedia', `${a},${b}`);
    expect(insertQuery(`gallery|before:${a}`, form)).toEqual({
      insert: 'gallery',
      place: 'before',
      anchor: a,
      media: `${a},${b}`,
    });
    expect(insertQuery('image|end', new FormData())).toEqual({ insert: 'image', place: 'end' });
    const image = pendingView(pendingBlock('image', 'end', null, [])!, ['nl'], undefined, [a]);
    expect(image.dropped).toBe(true);
    expect(image.values['new.p.mediaId']).toBe(a);
    expect(image.values['new.p.alt.nl']).toBe('');
    const gallery = pendingView(pendingBlock('gallery', 'end', null, [])!, ['nl'], undefined, [
      a,
      b,
    ]);
    expect(gallery.dropped).toBe(true);
    expect([
      gallery.values['new.p.images.0.mediaId'],
      gallery.values['new.p.images.1.mediaId'],
    ]).toEqual([a, b]);
    // A count the type cannot hold, or another type, starts empty as chosen.
    expect(
      pendingView(pendingBlock('gallery', 'end', null, [])!, ['nl'], undefined, [a]).dropped
    ).toBe(false);
    expect(
      pendingView(pendingBlock('quote', 'end', null, [])!, ['nl'], undefined, [a]).dropped
    ).toBe(false);
    // A picture without alt text is input: another action inserts it, or refuses it with its words.
    const post = { ...image.hidden, ...image.values };
    expect(
      pendingUntouched(pendingBlock('image', 'end', null, [])!, postedValues(post), LOCALES)
    ).toBe(false);
  });

  // Words a field only keeps beside something else (a caption without an image, a URL without
  // a label) read back as the empty block's props; the posted values still tell them apart.
  it('counts any one input in a pending block as touched, in every type', () => {
    for (const type of INSERTABLE_BLOCK_TYPES) {
      const p = pendingBlock(type, 'end', null, [])!;
      const shown = pendingView(p, ['nl']);
      const empty = formValues(BLOCK_DEFINITIONS[type].fields, undefined, ['nl']);
      const inputs = inputsOf(BLOCK_DEFINITIONS[type].fields, 'p', empty, ['nl']);
      // A row's `from` is hidden: it names a stored row, nobody types it.
      for (const key of Object.keys(empty).filter((k) => !k.endsWith('.from')))
        expect(
          inputs.map(([n]) => n),
          `${type}: ${key}`
        ).toContain(key);
      for (const [name, value] of inputs) {
        const post = { ...shown.hidden, ...shown.values, [`new.${name}`]: value };
        expect(pendingUntouched(p, postedValues(post), LOCALES), `${type}: ${name}`).toBe(false);
      }
    }
  });

  it('puts document issues on the form field that holds them, whatever its tab', () => {
    const e = new UseCaseError('invalid_input', 'bad', [
      { path: 'document.seo.canonical', message: 'content.seo.canonical.invalid' },
      { path: 'document.tags.2', message: 'content.tag.invalid' },
      { path: 'document.access.teaser.blocks', message: 'content.access.teaser-too-long' },
      { path: 'document.access.teaser', message: 'content.access.marker-needs-one-paywall' },
      { path: 'document.defaultLocale', message: 'i18n.default-not-in-locales' },
      { path: 'document.blocks.0.props.text.nl', message: 'x' },
    ]);
    expect(documentFieldIssues(e).map((i) => i.name)).toEqual([
      'canonical',
      'tags',
      'teaserBlocks',
      'teaser',
      'locales',
    ]);
  });

  it('names the teaser for a paywall refused on the save, and only there', () => {
    const save = (path: string, message: string) =>
      documentFieldIssues(new UseCaseError('invalid_input', 'bad', [{ path, message }]));
    const PAYWALL = 'content.access.paywall-without-marker';
    expect(save('document.blocks', PAYWALL)).toEqual([{ name: 'teaser', message: PAYWALL }]);
    expect(ISSUES[PAYWALL]).toBe('admin.content.error.paywallWithoutMarker');
    // Another issue on the save's block list names no field, as before.
    expect(save('document.blocks', 'content.reference.media-unrecorded')).toEqual([]);
    // The same key on a block action (root `blocks`): the refused insert has no teaser to name.
    expect(save('blocks', PAYWALL)).toEqual([]);
    expect(
      blockRefusalIssues(
        new UseCaseError('invalid_input', 'bad', [{ path: 'blocks', message: PAYWALL }])
      )
    ).toEqual([]);
  });
});

// A visible deletion crosses the ordinary form parser; leftover card fields cannot resurrect it.
it('saves explicit writer card removal, accepts undo and refuses unannounced card loss', () => {
  const quote = blocks.find((block) => block.type === 'quote')!;
  const base = ContentDocument.parse({
    type: 'article',
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl: 'Artikel' },
    blocks: [quote],
  });
  const parse = (content: unknown[], removedCardIds?: unknown) => {
    const post = new FormData();
    post.set('articleEditor', JSON.stringify({ type: 'doc', content, removedCardIds }));
    for (const [name, value] of Object.entries(formOf([quote]))) post.set(name, value);
    return formDocument(
      base,
      { 'title.nl': 'Artikel' },
      postedValues(Object.fromEntries(post.entries()) as Record<string, string>),
      '2026-11-10',
      'nl'
    );
  };
  const removed = parse([], [quote.id]);
  expect(removed.errors).toEqual([]);
  expect(removed.blocks).toEqual([]);
  const undone = parse([{ type: 'mycelCard', attrs: { blockId: quote.id } }], []);
  expect(undone.errors).toEqual([]);
  expect(undone.blocks.map((block) => block.id)).toEqual([quote.id]);
  expect(parse([]).errors).toEqual([
    { name: 'articleEditor', message: 'editor.markdown.invalid', line: 1 },
  ]);
});

// Removing a card between text blocks whose locales or names differ is refused with copy of
// its own; any other editor failure, such as a card that silently went missing, keeps the general
// sentence.
it('refuses an ambiguous text join with its own issue and nothing else with it', () => {
  const quote = blocks.find((block) => block.type === 'quote')!;
  const prose = (id: string, locales: string[], name?: Record<string, string>) =>
    Block.parse({
      id,
      type: 'rich-text',
      version: BLOCK_DEFINITIONS['rich-text'].version,
      ...(name ? { name } : {}),
      props: {
        content: Object.fromEntries(
          locales.map((l) => [
            l,
            { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: l }] }] },
          ])
        ),
      },
    });
  const save = (list: Block[], removedCardIds?: string[]) => {
    const base = ContentDocument.parse({
      type: 'article',
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      title: { nl: 'Artikel' },
      blocks: list,
    });
    const content = list
      .filter((block) => !(removedCardIds ?? [quote.id]).includes(block.id))
      .map((block) =>
        block.type === 'rich-text'
          ? {
              type: 'mycelProse',
              attrs: { blockId: block.id },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nl' }] }],
            }
          : { type: 'mycelCard', attrs: { blockId: block.id } }
      );
    const post = new FormData();
    post.set('articleEditor', JSON.stringify({ type: 'doc', content, removedCardIds }));
    for (const [name, value] of Object.entries(formOf([quote]))) post.set(name, value);
    return formDocument(
      base,
      { 'title.nl': 'Artikel' },
      postedValues(Object.fromEntries(post.entries()) as Record<string, string>),
      '2026-11-11',
      'nl'
    );
  };
  const refused = [{ name: 'articleEditor', message: 'content.blocks.merge-ambiguous', line: 1 }];
  // Different locales.
  const locales = [prose('a', ['nl', 'en']), quote, prose('b', ['nl'])];
  expect(save(locales, [quote.id]).errors).toEqual(refused);
  expect(issueCopy('content.blocks.merge-ambiguous')).toBe('admin.block.issue.mergeAmbiguous');
  // Different names in one locale.
  const names = [prose('a', ['nl'], { nl: 'Intro' }), quote, prose('b', ['nl'], { nl: 'Slot' })];
  expect(save(names, [quote.id]).errors).toEqual(refused);
  // The same card dropped without announcing its removal stays the general refusal.
  expect(save(locales).errors).toEqual([
    { name: 'articleEditor', message: 'editor.markdown.invalid', line: 1 },
  ]);
  // Text blocks that agree join as before.
  const joined = save([prose('a', ['nl']), quote, prose('b', ['nl'])], [quote.id]);
  expect(joined.errors).toEqual([]);
  expect(joined.blocks.map((block) => block.id)).toEqual(['a']);
});
