// The one form of the edit screen (#66 PR 2): every block's fields under its own prefix read
// back as its stored props, a block the form does not carry or the one being removed keeps its
// props, a pending block needs a known type and place, and core's issue paths land on the field.

import { describe, expect, it } from 'vitest';
import {
  BLOCK_DEFINITIONS,
  BLOCK_TYPES,
  Block,
  INSERTABLE_BLOCK_TYPES,
  UseCaseError,
  type BlockField,
} from '@mycel/core';
import { formValues, postedValues } from '#lib/editor/block-form.js';
import {
  blockIssueField,
  blockIssues,
  documentFieldIssues,
  formFieldOf,
  blockPrefix,
  blocksFrom,
  pendingBlock,
  pendingFields,
  pendingProps,
  pendingUntouched,
  pendingView,
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
  it('reads every block back as stored when nothing was typed', () => {
    expect(blocksFrom(blocks, postedValues(formOf(blocks)))).toEqual({ blocks, errors: [] });
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

  // Words a field only keeps beside something else (a caption without an image, a URL without
  // a label) read back as the empty block's props; the posted values still tell them apart.
  it('counts any one input in a pending block as touched, in every type', () => {
    for (const type of INSERTABLE_BLOCK_TYPES) {
      const p = pendingBlock(type, 'end', null, [])!;
      const shown = pendingView(p, ['nl']);
      const empty = formValues(BLOCK_DEFINITIONS[type].fields, undefined, ['nl']);
      const inputs = inputsOf(BLOCK_DEFINITIONS[type].fields, 'p', empty, ['nl']);
      for (const key of Object.keys(empty))
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
});
