// The three-way merge (ADR 026) as a pure function, and `content.item.update` on an older base:
// what both sides changed lands in one revision that names the merge; only a value both changed
// differently is a conflict, with its path, and nothing is written then.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import { systemPrincipal, type Principal } from '../../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT } from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';
import { mergeDocuments, takeValue, valueAt } from './merge.js';
import type { ContentDocument } from '../model.js';
import { mergeSave } from './save.js';

const text = (t: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: t }] }],
});
const prose = (id: string, nl: string, en?: string) => ({
  id,
  type: 'rich-text' as const,
  version: 1 as const,
  props: { content: { nl: text(nl), ...(en ? { en: text(en) } : {}) } },
});
const heading = (id: string, nl: string) => ({
  id,
  type: 'heading' as const,
  version: 1 as const,
  props: { text: { nl } },
});

/** Seven blocks, text and headings in turn, so no two text blocks ever meet. */
const page = () => ({
  type: 'page' as const,
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  title: { nl: 'Over ons', en: 'About us' },
  blocks: [1, 2, 3, 4, 5, 6, 7].map((n) =>
    n % 2 ? prose(`b${n}`, `Tekst ${n}`) : heading(`b${n}`, `Kop ${n}`)
  ),
});

type Doc = ReturnType<typeof page>;
const edit = (f: (d: Doc) => void): Doc => {
  const d = structuredClone(page());
  f(d);
  return d;
};

describe('mergeDocuments', () => {
  it('combines changes to different blocks, fields and locales without a conflict', () => {
    const mine = edit((d) => {
      d.blocks[6] = prose('b7', 'Mijn tekst 7');
      d.title.nl = 'Mijn titel';
    });
    const theirs = edit((d) => {
      d.blocks[2] = prose('b3', 'Agent 3');
      d.title.en = 'Their title';
    });
    const { document, conflicts } = mergeDocuments(page(), mine, theirs);
    expect(conflicts).toEqual([]);
    expect(document.title).toEqual({ nl: 'Mijn titel', en: 'Their title' });
    expect(document.blocks[2]).toEqual(prose('b3', 'Agent 3'));
    expect(document.blocks[6]).toEqual(prose('b7', 'Mijn tekst 7'));
  });

  it('merges the locales of one block, but text within one locale is one value', () => {
    const mine = edit((d) => (d.blocks[0] = prose('b1', 'Mijn 1')));
    const translated = edit((d) => (d.blocks[0] = prose('b1', 'Tekst 1', 'Text 1')));
    const merged = mergeDocuments(page(), mine, translated);
    expect(merged.conflicts).toEqual([]);
    expect(merged.document.blocks[0]).toEqual(prose('b1', 'Mijn 1', 'Text 1'));
    const other = edit((d) => (d.blocks[0] = prose('b1', 'Tekst 1 met een komma,')));
    const { conflicts } = mergeDocuments(page(), mine, other);
    expect(conflicts.map((c) => c.path)).toEqual(['blocks[id=b1].props.content.nl']);
  });

  it('names only the value both changed, and keeps the caller’s in the proposal', () => {
    const mine = edit((d) => {
      d.title.nl = 'Mijn titel';
      d.blocks[1] = heading('b2', 'Mijn kop');
    });
    const theirs = edit((d) => {
      d.title.nl = 'Hun titel';
      d.blocks[3] = heading('b4', 'Hun kop');
    });
    const { document, conflicts } = mergeDocuments(page(), mine, theirs);
    expect(conflicts).toEqual([
      { path: 'title.nl', base: 'Over ons', mine: 'Mijn titel', theirs: 'Hun titel' },
    ]);
    expect(document.title.nl).toBe('Mijn titel');
    expect(document.blocks[1]).toEqual(heading('b2', 'Mijn kop'));
    expect(document.blocks[3]).toEqual(heading('b4', 'Hun kop'));
  });

  it('removes a block one side removed; removed and changed is a choice', () => {
    const removed = edit((d) => d.blocks.splice(1, 2));
    const elsewhere = edit((d) => (d.blocks[6] = prose('b7', 'Elders')));
    const merged = mergeDocuments(page(), removed, elsewhere);
    expect(merged.conflicts).toEqual([]);
    expect(merged.document.blocks.map((b) => b.id)).toEqual(['b1', 'b4', 'b5', 'b6', 'b7']);
    expect(merged.document.blocks.at(-1)).toEqual(prose('b7', 'Elders'));

    const changed = edit((d) => (d.blocks[1] = heading('b2', 'Toch gewijzigd')));
    const choice = mergeDocuments(page(), removed, changed);
    expect(choice.conflicts.map((c) => c.path)).toEqual(['blocks[id=b2]']);
    // The other way round: the caller changed what the newest revision removed; it stays.
    const kept = mergeDocuments(page(), changed, removed);
    expect(kept.conflicts.map((c) => c.path)).toEqual(['blocks[id=b2]']);
    expect(kept.document.blocks.map((b) => b.id)).toEqual(['b1', 'b2', 'b4', 'b5', 'b6', 'b7']);
  });

  it('places additions after their predecessor, and two different orders are one choice', () => {
    const { id: _id, ...fresh } = heading('x', 'Nieuw');
    const mine = edit((d) => d.blocks.splice(2, 0, fresh as never));
    const theirs = edit((d) => d.blocks.splice(5, 0, heading('t', 'Hun nieuwe kop')));
    const { document, conflicts } = mergeDocuments(page(), mine, theirs);
    expect(conflicts).toEqual([]);
    expect(document.blocks.map((b) => b.id ?? 'new')).toEqual([
      'b1',
      'b2',
      'new',
      'b3',
      'b4',
      'b5',
      't',
      'b6',
      'b7',
    ]);

    const moved = edit((d) => d.blocks.push(d.blocks.shift()!));
    const reversed = edit((d) => d.blocks.reverse());
    expect(mergeDocuments(page(), moved, page()).document.blocks[0]!.id).toBe('b2');
    expect(mergeDocuments(page(), moved, reversed).conflicts.map((c) => c.path)).toEqual([
      'blocks#order',
    ]);
  });
});

describe('takeValue', () => {
  it('takes one value, an item back in its place, or an order', () => {
    const theirs = edit((d) => {
      d.title.nl = 'Hun titel';
      d.blocks[1] = heading('b2', 'Hun kop');
    });
    const removed = edit((d) => d.blocks.splice(1, 1));
    expect(takeValue(page(), theirs, 'title.nl').title.nl).toBe('Hun titel');
    expect(valueAt(theirs, 'blocks[id=b2].props.text.nl')).toBe('Hun kop');
    expect(takeValue(removed, theirs, 'blocks[id=b2]').blocks.map((b) => b.id)).toEqual(
      page().blocks.map((b) => b.id)
    );
    expect(takeValue(page(), removed, 'blocks[id=b2]').blocks).toHaveLength(6);
    const reversed = edit((d) => d.blocks.reverse());
    expect(takeValue(page(), reversed, 'blocks#order').blocks.map((b) => b.id)).toEqual(
      reversed.blocks.map((b) => b.id)
    );
    // A path that leads nowhere changes nothing; the empty path is the whole document.
    expect(takeValue(page(), theirs, 'blocks[id=nope].props')).toEqual(page());
    expect(takeValue(page(), theirs, '')).toEqual(theirs);
  });
});

describe('mergeSave', () => {
  const image = '01900000-0000-7000-8000-000000000a11';
  const doc = (d: Doc) => d as unknown as ContentDocument;

  it('makes the block list one choice when the merged tree breaks a rule of the document', () => {
    // Each side removes a heading with the text after it: alone each is valid, together b1 and
    // b5 would meet as two text blocks.
    const mine = edit((d) => d.blocks.splice(1, 2));
    const theirs = edit((d) => d.blocks.splice(2, 2));
    const { document, conflicts } = mergeSave(doc(page()), doc(mine), doc(theirs));
    expect(conflicts.map((c) => c.path)).toEqual(['blocks']);
    expect(document.blocks.map((b) => b.id)).toEqual(['b1', 'b4', 'b5', 'b6', 'b7']);
  });

  it('makes the whole document one choice when no block list explains it', () => {
    const base = edit((d) => Object.assign(d, { heroImageId: image }));
    const mine = edit(() => {});
    const theirs = edit((d) =>
      Object.assign(d, { heroImageId: image, heroAlt: { nl: 'Een plein' } })
    );
    const { conflicts } = mergeSave(doc(base), doc(mine), doc(theirs));
    expect(conflicts.map((c) => c.path)).toEqual(['']);
  });
});

describe('content.item.update on an older base', () => {
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let admin: Principal;
  beforeEach(() => {
    uow = new MemoryUnitOfWork({ clock: new FakeClock() });
    invoker = new Invoker(buildRegistry(), uow);
    admin = systemPrincipal(TENANT, 'test');
  });
  const save = (itemId: string, baseRevisionId: string, document: Doc | ContentDocument) =>
    invoker.run(useCases.updateItem, admin, { itemId, baseRevisionId, document });

  it('saves both changes in one revision that names the merge', async () => {
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug: 'over-ons',
      document: page(),
    });
    const agent = await save(
      item.id,
      revision.id,
      edit((d) => (d.blocks[2] = prose('b3', 'Agent 3')))
    );
    const editor = await save(
      item.id,
      revision.id,
      edit((d) => (d.blocks[6] = prose('b7', 'Redacteur 7')))
    );
    expect(agent.merge).toBeNull();
    expect(editor.merge).toEqual({
      baseRevisionId: revision.id,
      latestRevisionId: agent.revision.id,
    });
    expect(editor.revision.provenance).toEqual({
      merged: { baseRevisionId: revision.id, latestRevisionId: agent.revision.id },
    });
    expect(editor.revision.document.blocks[2]).toEqual(prose('b3', 'Agent 3'));
    expect(editor.revision.document.blocks[6]).toEqual(prose('b7', 'Redacteur 7'));
    expect(editor.item.latestRevisionId).toBe(editor.revision.id);
    const current = await save(item.id, editor.revision.id, editor.revision.document);
    expect(current.merge).toBeNull();
    const { revisions } = await invoker.run(useCases.listRevisions, admin, { itemId: item.id });
    expect(revisions).toHaveLength(4);
  });

  it('reports the revision found under the lock when another save lands after a read', async () => {
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug: 'race',
      document: page(),
    });
    const read = await invoker.run(useCases.getItem, admin, { itemId: item.id });
    let otherId = '';
    const raced = new Invoker(buildRegistry(), {
      run: (p, fn) =>
        uow.run(p, async (tx) => {
          const lock = tx.content.lock.bind(tx.content);
          tx.content.lock = async (id) => {
            const other = await save(
              item.id,
              revision.id,
              edit((d) => {
                d.title.nl = 'Onze titel';
                d.title.en = 'Unseen title';
              })
            );
            otherId = other.revision.id;
            return lock(id);
          };
          return fn(tx);
        }),
    });
    const result = await raced.run(useCases.updateItem, admin, {
      itemId: item.id,
      baseRevisionId: read.revision.id,
      document: edit((d) => {
        d.title.nl = 'Onze titel';
      }),
    });
    expect(result.merge).toEqual({ baseRevisionId: revision.id, latestRevisionId: otherId });
    expect(result.revision.id).toBe(otherId);
    expect(result.revision.document.title.en).toBe('Unseen title');
    expect(result.revision.provenance).toBeUndefined();
    const { revisions } = await invoker.run(useCases.listRevisions, admin, { itemId: item.id });
    expect(revisions).toHaveLength(2);
  });

  it('refuses a value both changed with every path, and writes nothing', async () => {
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug: 'over-ons',
      document: page(),
    });
    const agent = await save(
      item.id,
      revision.id,
      edit((d) => {
        d.title.nl = 'Agent';
        d.blocks[2] = prose('b3', 'Agent 3');
      })
    );
    await expect(
      save(
        item.id,
        revision.id,
        edit((d) => {
          d.title.nl = 'Redacteur';
          d.blocks[6] = prose('b7', 'Redacteur 7');
        })
      )
    ).rejects.toMatchObject({
      code: 'conflict',
      issues: [
        {
          path: 'baseRevisionId',
          message: 'content.revision.conflict',
          params: { latestRevisionId: agent.revision.id },
        },
        { path: 'document.title.nl', message: 'content.revision.conflict-value' },
      ],
    });
    const { revisions } = await invoker.run(useCases.listRevisions, admin, { itemId: item.id });
    expect(revisions).toHaveLength(2);
  });

  it('takes a repeated save once: a block posted again without its id is not added twice', async () => {
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug: 'over-ons',
      document: page(),
    });
    // A retry after a lost response: the same document, a new heading without an id, twice.
    const retried = edit((d) => {
      d.title.nl = 'Over ons, nieuw';
      d.blocks.splice(1, 0, {
        type: 'heading',
        version: 1,
        props: { text: { nl: 'Nieuw' } },
      } as never);
    });
    const first = await save(item.id, revision.id, retried);
    const second = await save(item.id, revision.id, retried);
    expect(first.merge).toBeNull();
    expect(second.merge).toEqual({
      baseRevisionId: revision.id,
      latestRevisionId: first.revision.id,
    });
    expect(second.revision.provenance).toEqual(first.revision.provenance);
    expect(second.revision.id).toBe(first.revision.id);
    expect(second.item.latestRevisionId).toBe(first.revision.id);
    expect(second.revision.document.blocks.filter((b) => b.type === 'heading')).toHaveLength(4);
    const { revisions } = await invoker.run(useCases.listRevisions, admin, { itemId: item.id });
    expect(revisions).toHaveLength(2);
    // Another change in the retry still merges, still with the block once.
    const third = await save(
      item.id,
      revision.id,
      edit((d) => {
        Object.assign(d, structuredClone(retried));
        d.blocks[0] = prose('b1', 'Ook nieuw');
      })
    );
    expect(third.revision.id).not.toBe(first.revision.id);
    expect(third.revision.document.blocks.map((b) => b.id)).toEqual(
      first.revision.document.blocks.map((b) => b.id)
    );
  });

  it('refuses a base that is no revision of the item as a conflict', async () => {
    const { item } = await invoker.run(useCases.createItem, admin, {
      slug: 'over-ons',
      document: page(),
    });
    await expect(
      save(item.id, '01900000-0000-7000-8000-0000000000ee', page())
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
