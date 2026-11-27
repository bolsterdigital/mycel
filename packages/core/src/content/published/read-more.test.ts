// "Read more" in memory (MY-304): which articles `content.published.get` puts under an article.
// Its own section's newest first, filled up with the site's newest, never itself or an article a
// dossier box already lists; only what is published in the asked locale, a restricted article as
// its teaser card; nothing on a page, on a site that switched it off or when nothing qualifies.
// The same filters in Postgres are `publishedCards` in packages/db; the rendered row is apps/web.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import { anonymousPrincipal, systemPrincipal } from '../../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT, pageDocument } from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';

const HOUR = 60 * 60 * 1000;

describe('read more under an article (MY-304)', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  const admin = systemPrincipal(TENANT, 'test');
  const visitor = anonymousPrincipal(TENANT, ['content:read']);

  beforeEach(() => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
  });

  const section = async (slug: string) =>
    (await invoker.run(useCases.createSection, admin, { slug, title: { nl: slug } })).id;

  /** An item published in `locales`, an hour after the one before, so `newest` has an order. */
  async function item(slug: string, over: Record<string, unknown> = {}, locales = ['nl']) {
    clock.advance(HOUR);
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug,
      document: pageDocument({
        type: 'article',
        title: { nl: `NL ${slug}`, en: `EN ${slug}` },
        ...over,
      }) as never,
    });
    for (const locale of locales)
      await invoker.run(useCases.publishItem, admin, {
        itemId: item.id,
        revisionId: revision.id,
        locale,
      });
    return item.id;
  }

  const read = (slug: string, type: 'article' | 'page' = 'article', locale = 'nl') =>
    invoker.run(useCases.getPublished, visitor, { type, slug, locale });
  const slugs = async (slug: string, locale = 'nl') =>
    (await read(slug, 'article', locale)).readMore?.map((e) => e.slug);

  it('shows its own section newest first, then fills up with the site newest', async () => {
    const [city, sport] = [await section('stad'), await section('sport')];
    await item('stad-oud', { sectionId: city });
    await item('sport-1', { sectionId: sport });
    await item('stad-nieuw', { sectionId: city });
    await item('los', {});
    await item('stuk', { sectionId: city });
    expect(await slugs('stuk')).toEqual(['stad-nieuw', 'stad-oud', 'los']);
    // Without a section it is the site's newest, never the article itself.
    await item('zonder', {});
    expect(await slugs('zonder')).toEqual(['stuk', 'los', 'stad-nieuw']);
  });

  it('leaves out drafts, other locales, pages and what a dossier box lists', async () => {
    const dossier = await item('dossier', { type: 'page', profile: 'dossier' });
    await item('lid', { dossiers: [{ itemId: dossier }] });
    await item('engels', {}, ['en']);
    await item('pagina', { type: 'page' });
    await invoker.run(useCases.createItem, admin, {
      slug: 'concept',
      document: pageDocument({ type: 'article' }) as never,
    });
    await item('ouder', {});
    await item('stuk', { dossiers: [{ itemId: dossier }] });
    const answer = await read('stuk');
    expect(answer.dossiers?.[0]?.members.map((m) => m.slug)).toEqual(['lid']);
    expect(answer.readMore?.map((e) => e.slug)).toEqual(['ouder']);
    // In English only the English article qualifies, and it is the reader's own: nothing left.
    expect(await slugs('engels', 'en')).toBeUndefined();
  });

  it('shows a restricted article as its teaser card', async () => {
    await item('leden', {
      lead: { nl: 'Voor leden.' },
      access: { level: 'members', teaser: 'lead' },
      blocks: [
        {
          type: 'heading',
          version: 1,
          props: { text: { nl: 'SENTINEL-BODY' } },
        },
      ],
    });
    await item('stuk', {});
    const [card] = (await read('stuk')).readMore ?? [];
    expect(card).toMatchObject({ slug: 'leden', restricted: true, title: 'NL leden' });
    expect(JSON.stringify(card)).not.toContain('SENTINEL-BODY');
  });

  it('shows nothing on a page, on a site that switched it off, or alone', async () => {
    await item('alleen', {});
    expect((await read('alleen')).readMore).toBeUndefined();
    await item('stuk', {});
    await item('pagina', { type: 'page' });
    expect((await read('pagina', 'page')).readMore).toBeUndefined();
    expect(await slugs('stuk')).toEqual(['alleen']);
    const { version, value } = await invoker.run(useCases.getSiteGeneral, admin, {});
    await invoker.run(useCases.updateSiteGeneral, admin, {
      baseVersion: version,
      general: { ...value, readMore: 'off' },
    });
    expect(await slugs('stuk')).toBeUndefined();
    // An update that omits it, as an older form does, keeps it off.
    const now = await invoker.run(useCases.getSiteGeneral, admin, {});
    await invoker.run(useCases.updateSiteGeneral, admin, {
      baseVersion: now.version,
      general: { timeZone: now.value.timeZone },
    });
    expect(await slugs('stuk')).toBeUndefined();
  });
});
