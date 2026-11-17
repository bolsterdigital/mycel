// The supporter list scenario of the adapter rules (adapter-rules.test.ts runs it over the memory
// adapter and over Postgres and compares both with `expectedSupporterList`). In a file of its own
// because the suite is at its size ceiling; it ingests its own supporters.

import {
  SupporterEvent,
  ingest,
  useCases,
  type Invoker,
  type Principal,
  type UnitOfWork,
} from '@mycel/core';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 3, 9, minute)).toISOString();

/**
 * `supporter.list`: every live supporter of the tenant, newest activity first and the higher id
 * first within one moment, narrowed to a list (confirmed or pending, or one of the two) and to
 * the start of an address taken literally. A page ends with a cursor until the last one, the
 * total counts every match, and an erased supporter or another tenant's is never listed.
 */
export async function observeSupporterList(
  invoker: Invoker,
  uow: UnitOfWork,
  admin: Principal,
  other: Principal,
  erase: (tenantId: string) => Promise<unknown>
) {
  let n = 0;
  const add = (
    email: string,
    minute: number,
    type: 'newsletter.subscribed' | 'petition.signed',
    props: Record<string, unknown>,
    by = admin
  ) => {
    const id = `list-rule-${n++}`;
    return uow.run(by, (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id,
          type,
          email,
          occurred_at: at(minute),
          source: 'test',
          source_site: 'urn:mycel:test',
          source_ref: id,
          props,
        })
      )
    );
  };
  await add('anna@example.org', 1, 'newsletter.subscribed', { list: 'news' });
  await add('bram@example.org', 2, 'newsletter.subscribed', { list: 'news', confirmed: false });
  await add('cato@example.org', 3, 'newsletter.subscribed', { list: 'campaign' });
  await add('dirk@example.net', 4, 'petition.signed', {});
  // `_` and `%` in a search are characters: `a_` finds this one and not anna.
  await add('a_x@example.org', 5, 'newsletter.subscribed', { list: 'news' });
  // One moment for two supporters: the order falls to the id.
  await add('eva@example.org', 6, 'newsletter.subscribed', { list: 'news' });
  await add('finn@example.org', 6, 'newsletter.subscribed', { list: 'news' });
  await add('gone@example.org', 7, 'newsletter.subscribed', { list: 'news' });
  await add('vreemd@example.org', 8, 'newsletter.subscribed', { list: 'news' }, other);

  const gone = await invoker.run(useCases.getSupporter, admin, { email: 'gone@example.org' });
  await uow.run(admin, (ctx) => ctx.erasures.register(gone.id, gone.email));
  await erase(admin.tenantId);

  type Input = Parameters<typeof useCases.listSupporters.handler>[1];
  const list = (input: Partial<Input> = {}, by = admin) =>
    invoker.run(useCases.listSupporters, by, { limit: 50, ...input });
  const names = async (input: Partial<Input> = {}, by = admin) =>
    (await list(input, by)).supporters.map((s) => s.email.split('@')[0]).join(' ');
  const refused = (input: Record<string, unknown>) =>
    invoker.run(useCases.listSupporters, admin, input as never).then(
      () => 'served',
      (e: { code: string }) => e.code
    );

  const all = await list();
  const [first, second] = all.supporters;
  const walked: string[] = [];
  let pages = 0;
  let after: string | undefined;
  do {
    const page = await list({ limit: 2, ...(after ? { after } : {}) });
    walked.push(...page.supporters.map((s) => s.id));
    after = page.next ?? undefined;
    pages += 1;
  } while (after && pages < 10);

  const pending = await list({ list: 'news', status: 'pending' });
  return {
    // The two of one moment lead; which of them is first is `tieByIdDescending`.
    tied: [first?.email, second?.email].sort().join(' '),
    tieByIdDescending: Boolean(first && second && first.id > second.id),
    rest: all.supporters
      .slice(2)
      .map((s) => s.email.split('@')[0])
      .join(' '),
    total: all.total,
    next: all.next,
    walkedIsAll: walked.join(' ') === all.supporters.map((s) => s.id).join(' '),
    pages,
    news: await names({ list: 'news' }),
    newsTotal: (await list({ list: 'news', limit: 1 })).total,
    confirmed: await names({ list: 'news', status: 'confirmed' }),
    pending: await names({ list: 'news', status: 'pending' }),
    pendingRow: pending.supporters.map((s) => ({ lists: s.lists, pendingLists: s.pendingLists })),
    campaign: await names({ list: 'campaign' }),
    unknownList: (await list({ list: 'nergens' })).total,
    start: await names({ q: 'a' }),
    normalised: await names({ q: ' ANNA@Ex ' }),
    literalUnderscore: await names({ q: 'a_' }),
    literalPercent: await names({ q: '%' }),
    notASubstring: await names({ q: 'example' }),
    startOnList: await names({ q: 'a', list: 'news', status: 'confirmed' }),
    erasedById: (await list({ q: gone.id.slice(0, 8) })).total,
    otherTenant: await names({}, other),
    statusWithoutList: await refused({ status: 'pending' }),
    malformedCursors: await Promise.all(
      ['x', '1.not-a-uuid', '1.ABCDEF00-0000-7000-8000-000000000000'].map((cursor) =>
        refused({ after: cursor })
      )
    ),
  };
}

export const expectedSupporterList = {
  tied: 'eva@example.org finn@example.org',
  tieByIdDescending: true,
  rest: 'a_x dirk cato bram anna',
  total: 7,
  next: null,
  walkedIsAll: true,
  pages: 4,
  news: 'finn eva a_x bram anna',
  newsTotal: 5,
  confirmed: 'finn eva a_x anna',
  pending: 'bram',
  pendingRow: [{ lists: [], pendingLists: ['news'] }],
  campaign: 'cato',
  unknownList: 0,
  start: 'a_x anna',
  normalised: 'anna',
  literalUnderscore: 'a_x',
  literalPercent: '',
  notASubstring: '',
  startOnList: 'a_x anna',
  erasedById: 0,
  otherTenant: 'vreemd',
  statusWithoutList: 'invalid_input',
  malformedCursors: ['invalid_input', 'invalid_input', 'invalid_input'],
};
