// The public read route (brief #8c § 10, ADR 012 rule 7) with two tenants: a published item is
// readable only under its own tenant's slug, the ETag follows revision and locale, a matching
// If-None-Match is a 304, and unknown, unpublished and restricted are the same `no-store` 404.
// No Authorization header is needed, and a valid key of tenant A opens nothing of tenant B.
import { describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { MemoryTenants, MemoryUnitOfWork, pageDocument, probeTenant } from '@mycel/core/testing';
import { createApp } from './app.js';

const A = '01900000-0000-7000-8000-00000000aaaa';
const B = '01900000-0000-7000-8000-00000000bbbb';

const doc = (title: string, extra: Record<string, unknown> = {}) =>
  pageDocument({
    title: { nl: title, en: `${title} (en)` },
    blocks: [{ type: 'heading', version: 1, props: { text: { nl: 'Kop', en: 'Heading' } } }],
    ...extra,
  });

async function setup() {
  const uow = new MemoryUnitOfWork();
  const invoker = new Invoker(buildRegistry(), uow);
  const tenants = new MemoryTenants([probeTenant(A), { ...probeTenant(B), slug: 'other' }]);
  const app = createApp({
    invoker,
    authenticate: async (h) => (h === 'Bearer key-of-a' ? systemPrincipal(A, 'api') : null),
    contentRead: { invoker, tenants, access: async (id) => uow.store.accessOf(id) },
  });
  const publish = async (
    tenant: string,
    slug: string,
    document: Record<string, unknown>,
    locales = ['nl']
  ) => {
    const admin = systemPrincipal(tenant, 'test');
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug,
      document: document as never,
    });
    for (const locale of locales)
      await invoker.run(useCases.publishItem, admin, {
        itemId: item.id,
        revisionId: revision.id,
        locale,
      });
    return { item, revision, admin };
  };
  const read = (path: string, headers: Record<string, string> = {}) =>
    app.request(`/v1/sites/${path}`, { headers });
  return { invoker, publish, read };
}

describe('GET /v1/sites/{tenant}/content/{type}/{slug}', () => {
  it('serves a published item without credentials, only under its own tenant', async () => {
    const { publish, read } = await setup();
    await publish(A, 'about', doc('Over ons'));
    const ok = await read('probe/content/page/about');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('application/json');
    expect(ok.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=600');
    expect(ok.headers.get('set-cookie')).toBeNull();
    expect(ok.headers.get('vary')).toBeNull();
    expect(await ok.json()).toMatchObject({ type: 'page', slug: 'about', locale: 'nl' });

    const elsewhere = await read('other/content/page/about');
    expect(elsewhere.status).toBe(404);
    // A key of tenant A changes nothing: the route never reads Authorization.
    const withKey = await read('other/content/page/about', { authorization: 'Bearer key-of-a' });
    expect(withKey.status).toBe(404);
    expect((await read('nobody/content/page/about')).status).toBe(404);
    expect((await read('probe/content/post/about')).status).toBe(404);
  });

  it('has a strong ETag that follows revision and locale, and answers 304 on a match', async () => {
    const { invoker, publish, read } = await setup();
    const { item, revision, admin } = await publish(A, 'about', doc('Over ons'), ['nl', 'en']);
    const nl = await read('probe/content/page/about');
    const etag = nl.headers.get('etag')!;
    expect(etag).toMatch(new RegExp(`^"${revision.id}:nl:[\\w-]+"$`));
    const en = await read('probe/content/page/about?locale=en');
    expect(await en.json()).toMatchObject({ locale: 'en', title: 'Over ons (en)' });
    expect(en.headers.get('etag')).not.toBe(etag);

    const again = await read('probe/content/page/about', { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);

    const next = await invoker.run(useCases.updateItem, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      document: doc('Nieuw') as never,
    });
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: next.revision.id,
      locale: 'nl',
    });
    const changed = await read('probe/content/page/about', { 'if-none-match': etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).toMatch(new RegExp(`^"${next.revision.id}:nl:`));
  });

  it('is one no-store 404 for an unpublished locale, a draft and a restricted item', async () => {
    const { invoker, publish, read } = await setup();
    await publish(A, 'about', doc('Over ons'));
    await publish(
      A,
      'members',
      doc('Leden', { access: { level: 'members', teaser: { blocks: 0 } } })
    );
    await invoker.run(useCases.createItem, systemPrincipal(A, 'test'), {
      slug: 'draft',
      document: doc('Concept') as never,
    });
    const misses = [
      await read('probe/content/page/about?locale=en'),
      await read('probe/content/page/draft'),
      await read('probe/content/page/members'),
      await read('probe/content/page/nothing'),
    ];
    const bodies = await Promise.all(misses.map((r) => r.json()));
    for (const r of misses) {
      expect(r.status).toBe(404);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('content-type')).toBe('application/problem+json');
    }
    // Nothing tells a restricted item apart from a missing one.
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it('serves an article with its public metadata', async () => {
    const { invoker, publish, read } = await setup();
    const author = await invoker.run(useCases.createAuthor, systemPrincipal(A, 'test'), {
      slug: 'sam',
      name: 'Sam',
      email: 'sam@example.org',
    });
    await publish(
      A,
      'story',
      doc('Verhaal', { type: 'article', lead: { nl: 'Kort.' }, authorIds: [author.id] })
    );
    const res = await read('probe/content/article/story');
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({
      type: 'article',
      lead: 'Kort.',
      authors: [{ slug: 'sam', name: 'Sam' }],
      section: null,
    });
    expect(body).not.toContain('sam@example.org');
    expect((await read('probe/content/page/story')).status).toBe(404);
  });
});
