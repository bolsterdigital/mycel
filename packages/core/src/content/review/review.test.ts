// Offering a locale for publication over the memory store: who may offer, what
// publishing and scheduling do to the offer, that saving or offering again never makes it news a
// second time, and that the attention list shows it only to whoever may publish. The database
// half (columns, the one read, RLS) is in packages/db/src/attention.test.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import type { Capability, Principal } from '../../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT, expectCode, principal } from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';

const AUTHOR: Capability[] = ['content:read', 'content:write', 'media:read', 'media:write'];
const EDITOR: Capability[] = [...AUTHOR, 'content:publish'];
const READER: Capability[] = ['content:read'];
const minutes = (n: number) => n * 60_000;

const operator = (n: number, capabilities: Capability[]): Principal =>
  principal({
    actor: {
      kind: 'operator',
      operatorId: `01900000-0000-7000-8000-0000000a000${n}`,
      email: `lid${n}@example.org`,
    },
    capabilities,
  });

describe('content.review', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  const author = operator(1, AUTHOR);
  const editor = operator(2, EDITOR);

  beforeEach(() => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
  });

  const document = (title: string) => ({
    type: 'article' as const,
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl: title, en: `${title} (en)` },
    blocks: [],
  });
  const create = (slug = 'stuk') =>
    invoker.run(useCases.createItem, editor, { slug, document: document('Een stuk') });
  const offer = (p: Principal, itemId: string, locale = 'nl', note?: string) =>
    invoker.run(useCases.requestContentReview, p, {
      itemId,
      locale,
      ...(note === undefined ? {} : { note }),
    });
  const review = (item: { publication: { locale: string; review: unknown }[] }, locale = 'nl') =>
    item.publication.find((p) => p.locale === locale)?.review;
  const attention = (p: Principal) => invoker.run(useCases.listAttention, p, {});

  it('lets an author offer one locale, with a note, and take it back', async () => {
    const { item } = await create();
    const offered = await offer(author, item.id, 'nl', '  Klaar van mijn kant.  ');
    expect(review(offered)).toEqual({
      since: clock.now().toISOString(),
      note: 'Klaar van mijn kant.',
    });
    expect(review(offered, 'en')).toBeNull();
    expect(offered.publication.find((p) => p.locale === 'nl')?.status).toBe('draft');

    const back = await invoker.run(useCases.withdrawContentReview, author, {
      itemId: item.id,
      locale: 'nl',
    });
    expect(review(back)).toBeNull();
  });

  it('refuses a member who may not write, and an offer with nothing new to look at', async () => {
    const { item, revision } = await create();
    await expectCode(offer(operator(3, READER), item.id), 'forbidden');
    await expectCode(
      invoker.run(useCases.withdrawContentReview, operator(3, READER), {
        itemId: item.id,
        locale: 'nl',
      }),
      'forbidden'
    );
    await invoker.run(useCases.publishItem, editor, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
    await expectCode(offer(author, item.id), 'invalid_input');
    await expectCode(offer(author, item.id, 'de'), 'invalid_input');
  });

  it('keeps the first moment when the author saves or offers again, and takes the new note', async () => {
    const { item, revision } = await create();
    const first = clock.now().toISOString();
    await offer(author, item.id, 'nl', 'eerste');
    clock.advance(minutes(5));
    await invoker.run(useCases.updateItem, author, {
      itemId: item.id,
      baseRevisionId: revision.id,
      document: document('Een beter stuk'),
    });
    const again = await offer(author, item.id, 'nl', 'tweede');
    expect(review(again)).toEqual({ since: first, note: 'tweede' });
    const cleared = await offer(author, item.id, 'nl');
    expect(review(cleared)).toEqual({ since: first, note: null });
  });

  it('is answered by publishing or scheduling the locale', async () => {
    const a = await create('a');
    await offer(author, a.item.id);
    const published = await invoker.run(useCases.publishItem, editor, {
      itemId: a.item.id,
      revisionId: a.revision.id,
      locale: 'nl',
    });
    expect(review(published)).toBeNull();

    const b = await create('b');
    await offer(author, b.item.id);
    const planned = await invoker.run(useCases.scheduleItem, editor, {
      itemId: b.item.id,
      revisionId: b.revision.id,
      locale: 'nl',
      at: new Date(clock.now().getTime() + minutes(60)).toISOString(),
    });
    expect(review(planned)).toBeNull();
  });

  it('shows an offer to whoever may publish, as news until the list is read, and drops it once answered', async () => {
    const { item, revision } = await create();
    await offer(author, item.id, 'en');
    await expect(attention(author)).resolves.toMatchObject({ items: [] });
    const { items, summary } = await attention(editor);
    expect(items).toEqual([
      {
        key: `review:${item.id}:en`,
        source: 'review',
        subjectId: item.id,
        locale: 'en',
        detail: 'Een stuk (en)',
        count: 1,
        since: clock.now().toISOString(),
        unread: true,
      },
    ]);
    expect(summary.sources).toEqual([{ source: 'review', total: 1, unread: 1 }]);

    // A member who may read but not publish does not see it either.
    expect((await attention(operator(3, READER))).items).toEqual([]);

    await invoker.run(useCases.publishItem, editor, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'en',
    });
    expect((await attention(editor)).items).toEqual([]);
  });
});
