// The public person boundary is one registry contract: publication pins and explicit fields,
// not an editorial record filtered independently by HTTP, MCP and HTML renderers.
import { describe, it, expect } from 'vitest';
import { resolvePeopleGrid } from './grid.js';
import { PeopleGridProps } from './grid-block.js';
import { Invoker } from '../../invoke.js';
import { anonymousPrincipal, systemPrincipal } from '../../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT } from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';

function setup() {
  const uow = new MemoryUnitOfWork({ clock: new FakeClock() });
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = systemPrincipal(TENANT, 'test');
  const visitor = anonymousPrincipal(TENANT, ['content:read']);
  const createPerson = (slug: string, pagePolicy: 'auto' | 'always' | 'never' = 'auto') =>
    invoker.run(useCases.createPerson, admin, {
      slug,
      name: slug,
      pagePolicy,
      email: 'INTERNAL@example.org',
      publicEmail: 'public@example.org',
      bio: { nl: 'Biografie', en: 'Biography' },
    });
  async function article(
    slug: string,
    authorIds: string[],
    access: 'public' | 'members' = 'public'
  ) {
    const created = await invoker.run(useCases.createItem, admin, {
      slug,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: `${slug}-nl`, en: `${slug}-en` },
        lead: { nl: 'Introduction', en: 'Introduction EN' },
        authorIds,
        access: { level: access, teaser: 'lead' },
        blocks: [],
      },
    });
    return created;
  }
  const publish = (created: Awaited<ReturnType<typeof article>>, locale: string) =>
    invoker.run(useCases.publishItem, admin, {
      itemId: created.item.id,
      revisionId: created.revision.id,
      locale,
    });
  const grid = (principal: typeof visitor, input: { locale: string; props: unknown }) =>
    uow.run(principal, async (ctx) => ({
      people: await resolvePeopleGrid(ctx, PeopleGridProps.parse(input.props), input.locale),
    }));
  return { invoker, admin, visitor, createPerson, article, publish, grid };
}

describe('public people', () => {
  it('treats unavailable and unknown identically and keeps the editorial register closed', async () => {
    const { invoker, visitor, createPerson } = setup();
    await createPerson('draft-only');
    const outcomes = await Promise.allSettled(
      ['draft-only', 'unknown'].map((slug) =>
        invoker.run(useCases.getPublicPerson, visitor, { slug, locale: 'nl' })
      )
    );
    expect(outcomes[0]).toEqual(outcomes[1]);
    await expect(invoker.run(useCases.listPeople, visitor, {})).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('projects one locale and public contact explicitly, including lists and site off', async () => {
    const { invoker, visitor, admin, createPerson } = setup();
    await createPerson('always', 'always');
    const result = await invoker.run(useCases.getPublicPerson, visitor, {
      slug: 'always',
      locale: 'en',
    });
    expect(result.person.bio).toBe('Biography');
    expect(result.person.publicEmail).toBe('public@example.org');
    expect(result.person).not.toHaveProperty('email');
    expect(JSON.stringify(result)).not.toContain('INTERNAL');
    expect(result.articles).toEqual([]);
    const listed = await invoker.run(useCases.listPublicPeople, visitor, { locale: 'nl' });
    expect(listed.people.map((p) => p.slug)).toEqual(['always']);
    expect(JSON.stringify(listed)).not.toContain('INTERNAL');
    await invoker.run(useCases.updateSiteGeneral, admin, {
      baseVersion: 0,
      general: { timeZone: 'UTC', personPages: 'off' },
    });
    await expect(
      invoker.run(useCases.getPublicPerson, visitor, { slug: 'always', locale: 'nl' })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await invoker.run(useCases.listPublicPeople, visitor, { locale: 'nl' })).toEqual({
      people: [],
      next: null,
    });
  });

  it('uses pinned authors and titles, exact published locale and the same byline decision', async () => {
    const { invoker, visitor, admin, createPerson, article, publish } = setup();
    const sam = await createPerson('sam');
    const lee = await createPerson('lee');
    const created = await article('story', [sam.id]);
    await publish(created, 'nl');
    const draft = { ...created.revision.document, title: { nl: 'DRAFT SECRET' } };
    if (draft.type !== 'article') throw new Error('article expected');
    draft.authorIds = [lee.id];
    await invoker.run(useCases.updateItem, admin, {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: draft,
    });
    const profile = await invoker.run(useCases.getPublicPerson, visitor, {
      slug: 'sam',
      locale: 'nl',
    });
    expect(profile.articles.map((a) => a.title)).toEqual(['story-nl']);
    expect(profile.total).toBe(1);
    expect(JSON.stringify(profile)).not.toContain('DRAFT');
    expect(
      (await invoker.run(useCases.getPublicPerson, visitor, { slug: 'sam', locale: 'en' })).articles
    ).toEqual([]);
    await expect(
      invoker.run(useCases.getPublicPerson, visitor, { slug: 'lee', locale: 'nl' })
    ).rejects.toMatchObject({ code: 'not_found' });
    const published = await invoker.run(useCases.getPublished, visitor, {
      type: 'article',
      slug: 'story',
      locale: 'nl',
    });
    expect(published.authors).toEqual([
      { id: sam.id, name: 'sam', slug: 'sam', pageEnabled: true },
    ]);
    await invoker.run(useCases.updatePerson, admin, {
      personId: sam.id,
      baseUpdatedAt: sam.updatedAt,
      name: sam.name,
      pagePolicy: 'never',
    });
    expect(
      (await invoker.run(useCases.getPublished, visitor, { type: 'article', slug: 'story' }))
        .authors?.[0]?.pageEnabled
    ).toBe(false);
    await expect(
      invoker.run(useCases.getPublicPerson, visitor, { slug: 'sam', locale: 'nl' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('counts published restricted articles for auto without exposing their cards or count', async () => {
    const { invoker, visitor, createPerson, article, publish } = setup();
    const sam = await createPerson('sam');
    const restricted = await article('restricted-secret', [sam.id], 'members');
    await publish(restricted, 'en');
    const result = await invoker.run(useCases.getPublicPerson, visitor, {
      slug: 'sam',
      locale: 'en',
    });
    expect(result.articles).toEqual([]);
    expect(result.total).toBe(0);
    expect(JSON.stringify(result)).not.toContain('restricted-secret');
    expect(
      (await invoker.run(useCases.listPublicPeople, visitor, { locale: 'nl' })).people
    ).toHaveLength(1);
  });

  it('paginates visible cards and discovery past unavailable records, and isolates tenants', async () => {
    const { invoker, visitor, createPerson, article, publish } = setup();
    await createPerson('hidden');
    const sam = await createPerson('sam');
    await publish(await article('one', [sam.id]), 'nl');
    await publish(await article('two', [sam.id]), 'nl');
    const first = await invoker.run(useCases.getPublicPerson, visitor, {
      slug: 'sam',
      locale: 'nl',
      limit: 1,
    });
    const second = await invoker.run(useCases.getPublicPerson, visitor, {
      slug: 'sam',
      locale: 'nl',
      limit: 1,
      offset: first.nextOffset!,
    });
    expect(new Set([...first.articles, ...second.articles].map((a) => a.id)).size).toBe(2);
    expect(second.nextOffset).toBeNull();
    const discovery = await invoker.run(useCases.listPublicPeople, visitor, {
      locale: 'nl',
      limit: 1,
    });
    const next = discovery.next
      ? await invoker.run(useCases.listPublicPeople, visitor, {
          locale: 'nl',
          limit: 1,
          after: discovery.next,
        })
      : { people: [] };
    expect([...discovery.people, ...next.people].map((p) => p.slug)).toEqual(['sam']);
    await expect(
      invoker.run(
        useCases.getPublicPerson,
        anonymousPrincipal('01900000-0000-7000-8000-00000000bbbb', ['content:read']),
        {
          slug: 'sam',
          locale: 'nl',
        }
      )
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('authored person grids', () => {
  it('keeps chosen order and public fields without enabling an unavailable profile', async () => {
    const { invoker, admin, visitor, createPerson, article, publish, grid } = setup();
    const sam = await createPerson('sam');
    const hidden = await createPerson('hidden', 'never');
    const always = await createPerson('always', 'always');
    const group = await invoker.run(useCases.createPersonGroup, admin, {
      name: { en: 'Team' },
      personIds: [hidden.id, sam.id, always.id],
    });
    const read = () =>
      grid(visitor, {
        locale: 'en',
        props: { source: 'group', groupId: group.id },
      });
    const first = await read();
    expect(first.people.map((p) => [p.id, p.pageEnabled])).toEqual([
      [hidden.id, false],
      [sam.id, false],
      [always.id, true],
    ]);
    expect(first.people.every((p) => p.bio === 'Biography')).toBe(true);
    expect(JSON.stringify(first)).not.toContain('INTERNAL');
    expect(first.people.every((p) => p.publicEmail === 'public@example.org')).toBe(true);
    await publish(await article('sam-article', [sam.id]), 'nl');
    expect((await read()).people[1]?.pageEnabled).toBe(true);
    await invoker.run(useCases.updateSiteGeneral, admin, {
      baseVersion: 0,
      general: { timeZone: 'UTC', personPages: 'off' },
    });
    expect((await read()).people.every((p) => !p.pageEnabled)).toBe(true);
    const selected = await grid(visitor, {
      locale: 'nl',
      props: { people: [{ personId: sam.id }, { personId: hidden.id }] },
    });
    expect(selected.people.map((p) => p.id)).toEqual([sam.id, hidden.id]);
    expect(selected.people.every((p) => p.bio === 'Biografie')).toBe(true);
    const stranger = anonymousPrincipal('01900000-0000-7000-8000-00000000bbbb', ['content:read']);
    expect(
      await grid(stranger, {
        locale: 'nl',
        props: { people: [{ personId: sam.id }] },
      })
    ).toEqual({ people: [] });
    expect(
      await grid(stranger, {
        locale: 'nl',
        props: { source: 'group', groupId: group.id },
      })
    ).toEqual({ people: [] });
  });

  it('checks grid references on save, keeping the existing author reference distinct', async () => {
    const { invoker, admin, createPerson } = setup();
    const person = await createPerson('team-member');
    const group = await invoker.run(useCases.createPersonGroup, admin, {
      name: { en: 'Team' },
      personIds: [person.id],
    });
    const create = (props: Record<string, unknown>) =>
      invoker.run(useCases.createItem, admin, {
        slug: 'team',
        document: {
          type: 'page',
          defaultLocale: 'en',
          locales: ['en'],
          title: { en: 'Team' },
          blocks: [{ type: 'people-grid', version: 1, props }],
        },
      });
    await expect(
      create({ people: [{ personId: '01900000-0000-7000-8000-00000000ffff' }] })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      create({ source: 'group', groupId: '01900000-0000-7000-8000-00000000ffff' })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const result = await create({
      source: 'group',
      groupId: group.id,
      people: [{ personId: person.id }],
    });
    expect(result.revision.document.blocks[0]?.type).toBe('people-grid');
  });
});
