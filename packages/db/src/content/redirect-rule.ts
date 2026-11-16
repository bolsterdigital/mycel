// The old-address scenario of the adapter rules (adapter-rules.test.ts runs it over the memory
// adapter and over Postgres and compares both with `expectedRedirects`). In a file of its own
// because the suite grows one scenario per rule; it builds its own documents.

import { useCases, type Invoker, type Principal } from '@mycel/core';

const page = {
  type: 'page' as const,
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  title: { nl: 'Over ons', en: 'About us' },
  blocks: [] as never[],
};

/**
 * Old addresses (migration 0062): a rename of a published item keeps the old slug, oldest first;
 * every old slug of a chain resolves to the current one, in a published locale only; a move back
 * takes the slug out of the list; an old address holds its slug against another item of the
 * tenant and not of another tenant; a removal frees it.
 */
export async function observeRedirects(invoker: Invoker, admin: Principal, other: Principal) {
  const outcome = (p: Promise<unknown>) =>
    p.then(
      (r) => (r && typeof r === 'object' && 'slug' in r ? String(r.slug) : 'ok'),
      (e: { code?: string }) => e.code
    );
  const resolve = (slug: string, locale = 'nl', by = admin) =>
    outcome(invoker.run(useCases.resolveRedirect, by, { type: 'page', slug, locale }));
  const rename = (itemId: string, slug: string, by = admin) =>
    outcome(invoker.run(useCases.updateSlug, by, { itemId, slug }));
  const create = (slug: string, by = admin) =>
    outcome(invoker.run(useCases.createItem, by, { slug, document: page }));
  const olds = async (itemId: string) =>
    (await invoker.run(useCases.listRedirects, admin, { itemId })).redirects
      .map((r) => r.slug)
      .join(' ');

  const { item, revision } = await invoker.run(useCases.createItem, admin, {
    slug: 'a',
    document: page,
  });
  await invoker.run(useCases.publishItem, admin, {
    itemId: item.id,
    revisionId: revision.id,
    locale: 'nl',
  });
  await rename(item.id, 'b');
  await rename(item.id, 'c');
  const chain = { list: await olds(item.id), a: await resolve('a'), b: await resolve('b') };
  const english = await resolve('a', 'en');
  const otherTenant = await resolve('a', 'nl', other);
  const held = { create: await create('a'), otherTenant: await create('a', other) };
  await rename(item.id, 'b');
  const movedBack = { list: await olds(item.id), b: await resolve('b'), c: await resolve('c') };
  await invoker.run(useCases.deleteRedirect, admin, { itemId: item.id, slug: 'a' });
  const removed = { list: await olds(item.id), a: await resolve('a'), create: await create('a') };
  return { chain, english, otherTenant, held, movedBack, removed };
}

export const expectedRedirects = {
  chain: { list: 'a b', a: 'c', b: 'c' },
  english: 'not_found',
  otherTenant: 'not_found',
  held: { create: 'conflict', otherTenant: 'ok' },
  movedBack: { list: 'a c', b: 'not_found', c: 'b' },
  removed: { list: 'c', a: 'not_found', create: 'ok' },
};
