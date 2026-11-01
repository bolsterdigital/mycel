// The one form of the edit screen (#66 PR 2): every block's fields under its own prefix read
// back as its stored props, a block the form does not carry or the one being removed keeps its
// props, a pending block needs a known type and place, and core's issue paths land on the field.

import { describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS, BLOCK_TYPES, Block, UseCaseError } from '@mycel/core';
import { formValues, postedValues } from '#lib/editor/block-form.js';
import {
  blockIssues,
  documentFieldIssues,
  formFieldOf,
  blockPrefix,
  blocksFrom,
  pendingBlock,
  pendingFields,
  pendingProps,
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
