// The edit screen's conflict (ADR 026): the form comes back with the other save's changes in and
// one choice per value both changed; "use theirs" takes the newest value; a block one side
// removed comes back or goes as the proposal says; and the writer's document after a conflict is
// one the next save accepts, also with blocks the newest revision does not have.

import { describe, expect, it } from 'vitest';
import { ContentDocument } from '@mycel/core';
import { fromArticleEditor } from '#lib/editor/article-document.js';
import { applyChoices, proposalOf } from './merge-conflict.js';

const heading = (id: string, nl: string) => ({
  id,
  type: 'heading' as const,
  version: 1 as const,
  props: { text: { nl } },
});
const prose = (id: string, nl: string) => ({
  id,
  type: 'rich-text' as const,
  version: 1 as const,
  props: {
    content: {
      nl: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: nl }] }] },
    },
  },
});

const page = (title: string, blocks: unknown[]) =>
  ContentDocument.parse({
    type: 'page',
    defaultLocale: 'nl',
    locales: ['nl'],
    title: { nl: title },
    blocks,
  });

const revision = (document: ContentDocument) => ({
  actor: { kind: 'system' as const, job: 'agent' },
  createdAt: '2026-11-06T10:00:00.000Z',
  document,
});

const ctx = (values = {}) => ({ values, editing: 'nl', zone: 'Europe/Amsterdam', slug: null });

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(entries)) data.append(k, v);
  return data;
};

describe('proposalOf', () => {
  const base = page('Titel', [heading('h1', 'Een'), heading('h2', 'Twee')]);
  const mine = page('Mijn titel', [heading('h1', 'Mijn een'), heading('h2', 'Twee')]);
  const theirs = page('Hun titel', [heading('h1', 'Een'), heading('h2', 'Hun twee')]);

  it('asks only about the value both changed and fills in the rest of theirs', () => {
    const { view, values } = proposalOf(base, mine, revision(theirs), ctx());
    expect(view.choices).toEqual([
      expect.objectContaining({
        path: 'title.nl',
        label: 'admin.content.field.title',
        params: { locale: 'nl' },
        mine: 'Mijn titel',
        theirs: 'Hun titel',
        keep: null,
      }),
    ]);
    expect(values).toMatchObject({
      'title.nl': 'Mijn titel',
      'b.h1.p.text.nl': 'Mijn een',
      'b.h2.p.text.nl': 'Hun twee',
    });
  });

  it('names a block by its place and type, and carries a removed one as the proposal had it', () => {
    const removed = page('Titel', [heading('h2', 'Twee')]);
    const { view } = proposalOf(base, mine, revision(removed), ctx());
    expect(view.choices).toEqual([
      expect.objectContaining({
        path: 'blocks[id=h1]',
        label: 'admin.content.conflict.field.block',
        params: { n: '1' },
        blockType: 'heading',
        theirs: null,
        mine: 'Mijn een',
      }),
    ]);
    expect(JSON.parse(view.choices[0]!.keep!)).toEqual({
      blocks: [heading('h1', 'Mijn een'), { id: 'h2' }],
    });
    const other = page('Titel', [heading('h1', 'Hun een')]);
    const kept = proposalOf(base, mine, revision(other), ctx()).view.choices.find(
      (c) => c.path === 'blocks[id=h1].props.text.nl'
    );
    expect(kept?.keep).toBeNull();
  });
});

describe('applyChoices', () => {
  it('takes theirs where chosen and leaves the rest as posted', () => {
    const newest = page('Hun titel', [heading('h1', 'Hun een'), heading('h2', 'Twee')]);
    const posted = page('Mijn titel', [heading('h1', 'Mijn een'), heading('h2', 'Twee')]);
    const doc = applyChoices(
      posted,
      newest,
      form({ 'resolve.title.nl': 'theirs', 'resolve.blocks[id=h1].props.text.nl': 'mine' })
    );
    expect(doc.title.nl).toBe('Hun titel');
    expect(doc.blocks[0]).toEqual(heading('h1', 'Mijn een'));
  });

  it('puts back a block the newest removed when the editor keeps theirs', () => {
    const newest = page('Titel', [heading('h2', 'Twee')]);
    const keep = JSON.stringify({ blocks: [heading('h1', 'Mijn een'), { id: 'h2' }] });
    const doc = applyChoices(
      newest,
      newest,
      form({ 'resolve.blocks[id=h1]': 'mine', 'keep.blocks[id=h1]': keep })
    );
    expect(doc.blocks.map((b) => b.id)).toEqual(['h1', 'h2']);
    // A path into a prototype is ignored, whatever is posted.
    const odd = applyChoices(newest, newest, form({ 'resolve.__proto__.x': 'theirs' }));
    expect(odd).toEqual(newest);
  });
});

describe('the writer after a conflict', () => {
  const article = (title: string, blocks: unknown[]) =>
    ContentDocument.parse({ ...page(title, []), type: 'article', blocks });

  it('posts a document the next save on the newest revision accepts', () => {
    const base = article('Titel', [prose('p1', 'Tekst'), heading('h1', 'Kop')]);
    // Mine edited the text and added a card; theirs edited the same text and added a card.
    const mine = article('Titel', [
      prose('p1', 'Mijn tekst'),
      heading('h1', 'Kop'),
      heading('m', 'Mijn kaart'),
    ]);
    const theirs = article('Titel', [
      prose('p1', 'Hun tekst'),
      heading('t', 'Hun kaart'),
      heading('h1', 'Kop'),
    ]);
    const { view, values } = proposalOf(base, mine, revision(theirs), ctx({ articleEditor: '{}' }));
    expect(view.choices.map((c) => c.path)).toEqual(['blocks[id=p1].props.content.nl']);
    const next = fromArticleEditor(theirs, 'nl', JSON.parse(String(values.articleEditor)));
    expect(next.blocks.map((b) => b.id)).toEqual(['p1', 't', 'h1', 'm']);
  });
});
