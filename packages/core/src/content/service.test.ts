// Content use cases in memory: revisions, conflicts, per-locale publication, references and the
// public projection. The database conformance repeats the concurrency and isolation claims
// against Postgres, where locks and RLS are real.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal, systemPrincipal, type Principal } from '../principal.js';
import { FakeClock, MemoryUnitOfWork, probeForm } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const FORM = '01900000-0000-7000-8000-00000000f000';

const text = (t: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: t }] }],
});

const pageDoc = (en?: string) => ({
  type: 'page' as const,
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  title: { nl: 'Over ons', ...(en ? { en: 'About us' } : {}) },
  blocks: [
    {
      id: 'intro',
      type: 'rich-text' as const,
      version: 1 as const,
      props: { content: { nl: text('Wie we zijn.'), ...(en ? { en: text(en) } : {}) } },
    },
  ],
});

describe('content items', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let admin: Principal;
  const writer = (): Principal => ({
    ...systemPrincipal(TENANT, 'writer'),
    actor: { kind: 'api-key', keyId: 'writer' },
    capabilities: ['content:read', 'content:write'],
  });
  const visitor = () => anonymousPrincipal(TENANT, ['content:read', 'forms:read']);

  beforeEach(() => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
    admin = systemPrincipal(TENANT, 'test');
  });

  const create = (document = pageDoc(), slug = 'about', p = admin) =>
    invoker.run(useCases.createItem, p, { slug, document });

  it('creates a draft with a first revision attributed to the actor, and assigns block ids', async () => {
    const { item, revision } = await create({
      ...pageDoc(),
      blocks: [{ type: 'heading', version: 1, props: { text: { nl: 'Kop' } } }],
    } as never);
    expect(item.publication.map((s) => [s.locale, s.status])).toEqual([
      ['nl', 'draft'],
      ['en', 'draft'],
    ]);
    expect(item.latestRevisionId).toBe(revision.id);
    expect(revision.actor).toEqual(admin.actor);
    expect(revision.document.blocks[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses reserved and duplicate slugs per type, but pages and articles have their own space', async () => {
    await expect(create(pageDoc(), 'admin')).rejects.toMatchObject({ code: 'invalid_input' });
    await create();
    await expect(create()).rejects.toMatchObject({ code: 'conflict' });
    const article = { ...pageDoc(), type: 'article' as const };
    await expect(create(article as never)).resolves.toBeDefined();
  });

  it('saves on the latest revision only: a stale base is a typed conflict with no write', async () => {
    const { item, revision } = await create();
    const first = await invoker.run(useCases.updateItem, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      document: pageDoc('About us.'),
    });
    await expect(
      invoker.run(useCases.updateItem, admin, {
        itemId: item.id,
        baseRevisionId: revision.id,
        document: pageDoc('Lost update.'),
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    const { revisions } = await invoker.run(useCases.listRevisions, admin, { itemId: item.id });
    expect(revisions.map((r) => r.id)).toEqual([first.revision.id, revision.id]);
  });

  it('keeps old revisions as they were', async () => {
    const { item, revision } = await create();
    await invoker.run(useCases.updateItem, admin, {
      itemId: item.id,
      baseRevisionId: revision.id,
      document: pageDoc('Changed.'),
    });
    const old = await invoker.run(useCases.getItem, admin, {
      itemId: item.id,
      revisionId: revision.id,
    });
    expect(old.revision).toEqual(revision);
  });

  it('never changes the type, and keeps a published locale in the document', async () => {
    const { item, revision } = await create(pageDoc('Hello.'));
    await expect(
      invoker.run(useCases.updateItem, admin, {
        itemId: item.id,
        baseRevisionId: revision.id,
        document: { ...pageDoc(), type: 'article' } as never,
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'en',
    });
    await expect(
      invoker.run(useCases.updateItem, admin, {
        itemId: item.id,
        baseRevisionId: revision.id,
        document: { ...pageDoc(), locales: ['nl'], title: { nl: 'x' } },
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  describe('publication per locale (ADR 018 rules 3 and 9)', () => {
    it('publishing nl keeps the en draft hidden; a later save changes nothing live', async () => {
      const { item, revision } = await create(pageDoc('ENGLISH DRAFT'));
      const live = await invoker.run(useCases.publishItem, admin, {
        itemId: item.id,
        revisionId: revision.id,
        locale: 'nl',
      });
      expect(live.publication.find((s) => s.locale === 'en')!.status).toBe('draft');

      const page = await invoker.run(useCases.getPage, visitor(), {
        slug: 'about',
        acceptLanguage: 'en',
      });
      expect(page.locale).toBe('nl');
      expect(page.locales).toEqual(['nl']);
      expect(JSON.stringify(page)).not.toContain('ENGLISH DRAFT');
      await expect(
        invoker.run(useCases.getPage, visitor(), { slug: 'about', locale: 'en' })
      ).rejects.toMatchObject({ code: 'not_found' });

      const saved = await invoker.run(useCases.updateItem, admin, {
        itemId: item.id,
        baseRevisionId: revision.id,
        document: { ...pageDoc('x'), title: { nl: 'Nieuwe titel', en: 'x' } },
      });
      const nl = saved.item.publication.find((s) => s.locale === 'nl')!;
      expect(nl.publishedRevisionId).toBe(revision.id);
      expect(nl.hasUnpublishedChanges).toBe(true);
      expect((await invoker.run(useCases.getPage, visitor(), { slug: 'about' })).title).toBe(
        'Over ons'
      );
    });

    it('publishing an older revision keeps the newer draft; publishing it again changes nothing', async () => {
      const { item, revision } = await create();
      const later = await invoker.run(useCases.updateItem, admin, {
        itemId: item.id,
        baseRevisionId: revision.id,
        document: pageDoc('x'),
      });
      const target = { itemId: item.id, revisionId: revision.id, locale: 'nl' };
      const once = await invoker.run(useCases.publishItem, admin, target);
      clock.advance(60_000);
      const twice = await invoker.run(useCases.publishItem, admin, target);
      expect(twice).toEqual(once);
      expect(twice.latestRevisionId).toBe(later.revision.id);
    });

    it('unpublish takes one locale offline and marks it unpublished, not draft', async () => {
      const { item, revision } = await create(pageDoc('Hello.'));
      for (const locale of ['nl', 'en'])
        await invoker.run(useCases.publishItem, admin, {
          itemId: item.id,
          revisionId: revision.id,
          locale,
        });
      const after = await invoker.run(useCases.unpublishItem, admin, {
        itemId: item.id,
        locale: 'nl',
      });
      expect(after.publication.map((s) => [s.locale, s.status])).toEqual([
        ['nl', 'unpublished'],
        ['en', 'published'],
      ]);
      expect((await invoker.run(useCases.getPage, visitor(), { slug: 'about' })).locale).toBe('en');
    });

    it("refuses an incomplete locale, another item's revision and a locale the item lacks", async () => {
      const a = await create();
      const b = await create(pageDoc(), 'other');
      await expect(
        invoker.run(useCases.publishItem, admin, {
          itemId: a.item.id,
          revisionId: a.revision.id,
          locale: 'en',
        })
      ).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(
        invoker.run(useCases.publishItem, admin, {
          itemId: a.item.id,
          revisionId: b.revision.id,
          locale: 'nl',
        })
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        invoker.run(useCases.publishItem, admin, {
          itemId: a.item.id,
          revisionId: a.revision.id,
          locale: 'de',
        })
      ).rejects.toMatchObject({ code: 'invalid_input' });
    });

    it('writing does not grant publishing', async () => {
      const { item, revision } = await create(pageDoc(), 'about', writer());
      await expect(
        invoker.run(useCases.publishItem, writer(), {
          itemId: item.id,
          revisionId: revision.id,
          locale: 'nl',
        })
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('never serves a restricted page or an article through the public page query', async () => {
      const restricted = {
        ...pageDoc(),
        access: { level: 'members' as const, teaser: { blocks: 0 } },
      };
      const r = await create(restricted, 'members');
      await invoker.run(useCases.publishItem, admin, {
        itemId: r.item.id,
        revisionId: r.revision.id,
        locale: 'nl',
      });
      await expect(
        invoker.run(useCases.getPage, visitor(), { slug: 'members' })
      ).rejects.toMatchObject({
        code: 'not_found',
      });

      const author = await invoker.run(useCases.createAuthor, admin, {
        slug: 'sam',
        name: 'Sam',
        email: 'sam@example.org',
      });
      const a = await create(
        { ...pageDoc(), type: 'article', authorIds: [author.id] } as never,
        'story'
      );
      await invoker.run(useCases.publishItem, admin, {
        itemId: a.item.id,
        revisionId: a.revision.id,
        locale: 'nl',
      });
      await expect(
        invoker.run(useCases.getPage, visitor(), { slug: 'story' })
      ).rejects.toMatchObject({
        code: 'not_found',
      });
    });

    it('serves nothing when nothing is published, and never falls back to the latest draft', async () => {
      await create();
      await expect(
        invoker.run(useCases.getPage, visitor(), { slug: 'about' })
      ).rejects.toMatchObject({
        code: 'not_found',
      });
    });
  });

  describe('references (ADR 004 rule 6)', () => {
    it('refuses forms, items, authors and sections the tenant does not have', async () => {
      await uow.run(systemPrincipal(OTHER, 't'), (ctx) => ctx.forms.insert(probeForm(FORM)));
      const foreignAuthor = await invoker.run(useCases.createAuthor, systemPrincipal(OTHER, 't'), {
        slug: 'x',
        name: 'X',
      });
      const withForm = {
        ...pageDoc(),
        blocks: [
          { id: 'f', type: 'signup-form' as const, version: 1 as const, props: { formId: FORM } },
        ],
      };
      await expect(create(withForm)).rejects.toMatchObject({ code: 'invalid_input' });

      const link = {
        ...pageDoc(),
        blocks: [
          {
            id: 'p',
            type: 'rich-text' as const,
            version: 1 as const,
            props: {
              content: {
                nl: {
                  type: 'doc' as const,
                  content: [
                    {
                      type: 'paragraph' as const,
                      content: [
                        {
                          type: 'text' as const,
                          text: 'x',
                          marks: [
                            {
                              type: 'link' as const,
                              attrs: { itemId: '01900000-0000-7000-8000-0000000000ff' },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        ],
      };
      await expect(create(link)).rejects.toMatchObject({ code: 'invalid_input' });

      const article = { ...pageDoc(), type: 'article' as const, authorIds: [foreignAuthor.id] };
      const error = await create(article as never).catch((e) => e);
      expect(error).toMatchObject({ code: 'invalid_input' });
      expect(JSON.stringify(error.issues)).not.toContain('X');

      const foreignSection = await invoker.run(
        useCases.createSection,
        systemPrincipal(OTHER, 't'),
        { slug: 'x', title: { nl: 'Elders' } }
      );
      const sectioned = { ...pageDoc(), type: 'article' as const, sectionId: foreignSection.id };
      const sectionError = await create(sectioned as never).catch((e) => e);
      expect(sectionError).toMatchObject({
        code: 'invalid_input',
        issues: [{ path: 'sectionId', message: 'content.reference.section-unknown' }],
      });
      expect(JSON.stringify(sectionError.issues)).not.toContain('Elders');
    });

    it('lets an article without an author be a draft, but not be published', async () => {
      const { item, revision } = await create({ ...pageDoc(), type: 'article' } as never, 'story');
      await expect(
        invoker.run(useCases.publishItem, admin, {
          itemId: item.id,
          revisionId: revision.id,
          locale: 'nl',
        })
      ).rejects.toMatchObject({ code: 'invalid_input' });
    });
  });

  describe('editorial queries', () => {
    it("isolates tenants: another tenant's item id is not found", async () => {
      const { item } = await create();
      await expect(
        invoker.run(useCases.getItem, systemPrincipal(OTHER, 't'), { itemId: item.id })
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('pages lists newest first and filters by type and slug', async () => {
      const ids: string[] = [];
      for (const slug of ['a', 'b', 'c']) ids.push((await create(pageDoc(), slug)).item.id);
      const first = await invoker.run(useCases.listItems, admin, { limit: 2 });
      expect(first.items.map((i) => i.id)).toEqual([ids[2], ids[1]]);
      const second = await invoker.run(useCases.listItems, admin, { limit: 2, after: first.next! });
      expect(second).toEqual({ items: [expect.objectContaining({ id: ids[0] })], next: null });
      expect((await invoker.run(useCases.listItems, admin, { slug: 'b' })).items).toHaveLength(1);
      expect(
        (await invoker.run(useCases.listItems, admin, { type: 'article' })).items
      ).toHaveLength(0);
    });

    it('diffs two revisions by block id, deterministically', async () => {
      const { item, revision } = await create();
      const moved = {
        ...pageDoc(),
        blocks: [
          {
            id: 'top',
            type: 'heading' as const,
            version: 1 as const,
            props: { text: { nl: 'Nieuw' } },
          },
          { ...pageDoc().blocks[0]!, props: { content: { nl: text('Wie wij zijn.') } } },
        ],
      };
      const next = await invoker.run(useCases.updateItem, admin, {
        itemId: item.id,
        baseRevisionId: revision.id,
        document: moved,
      });
      const { changes } = await invoker.run(useCases.diffRevisions, admin, {
        itemId: item.id,
        fromRevisionId: revision.id,
        toRevisionId: next.revision.id,
      });
      expect(changes.map((c) => c.path)).toEqual([
        'blocks[id=top]',
        'blocks[id=intro].props.content.nl.content[0].content[0].text',
      ]);
      expect(changes[1]).toMatchObject({ before: 'Wie we zijn.', after: 'Wie wij zijn.' });
    });
  });

  describe('authors, sections and patterns', () => {
    it('keeps slugs unique per entity and fixed on update', async () => {
      const a = await invoker.run(useCases.createAuthor, admin, { slug: 'sam', name: 'Sam' });
      await expect(
        invoker.run(useCases.createAuthor, admin, { slug: 'sam', name: 'Other Sam' })
      ).rejects.toMatchObject({ code: 'conflict' });
      await invoker.run(useCases.createSection, admin, { slug: 'sam', title: { nl: 'Sam' } });
      const updated = await invoker.run(useCases.updateAuthor, admin, {
        authorId: a.id,
        name: 'Sam V.',
      });
      expect(updated).toMatchObject({ slug: 'sam', name: 'Sam V.', createdAt: a.createdAt });
    });

    it('applies a pattern as a copy with its own block ids', async () => {
      const pattern = await invoker.run(useCases.createPattern, admin, {
        name: { nl: 'Interview' },
        intendedType: 'page',
        blocks: [{ type: 'heading', version: 1, props: { text: { nl: 'Vraag' } } }],
      });
      const { revision } = await invoker.run(useCases.createItem, admin, {
        slug: 'interview',
        patternId: pattern.id,
        document: { ...pageDoc(), blocks: [] },
      });
      expect(revision.document.blocks).toHaveLength(1);
      expect(revision.document.blocks[0]!.id).not.toBe(pattern.blocks[0]!.id);
      await expect(
        invoker.run(useCases.createItem, admin, {
          slug: 'both',
          patternId: pattern.id,
          document: pageDoc(),
        })
      ).rejects.toMatchObject({ code: 'invalid_input' });
    });
  });
});
