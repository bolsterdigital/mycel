// Content against Postgres (TODO #8a, migration 0011): what the in-memory store cannot prove.
// The item lock makes two saves on one base end in exactly one revision and one conflict;
// revisions are immutable for mycel_app; a locale can only point at a revision of its own item;
// references stay inside the tenant; and scheduled publishing runs through the real jobs worker,
// in its own transactions, with every cancelled or replaced plan a no-op and a rolled-back
// schedule leaving neither a pin nor a job.
//
// The app clock runs an hour behind the database clock, so a job planned "a minute from now"
// for the app is already due for the worker's `run_at <= now()`; the handler still checks the
// pinned time against the app clock, which a test moves on before running the worker. Skips
// without DATABASE_URL and APP_DATABASE_URL; with E2E_REQUIRED=1 (CI) that is a failure.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  anonymousPrincipal,
  buildRegistry,
  parseJobPayload,
  publishScheduled,
  scheduleItem,
  systemPrincipal,
  useCases,
  type JobRecord,
  type Principal,
} from '@mycel/core';
import {
  FakeClock,
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
} from '@mycel/core/testing';
import {
  createDb,
  createUnitOfWork,
  migrate,
  runJobs,
  upsertTenant,
  uuidv7,
  uuidv7Ids,
  withTenant,
  type JobHandlers,
} from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl))
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL or APP_DATABASE_URL is not set');

const MINUTE = 60_000;

describe.skipIf(!operatorUrl || !appUrl)('content conformance', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const run = Math.random().toString(36).slice(2, 8);
  const clock = new FakeClock(new Date(Date.now() - 60 * MINUTE));
  const uow = createUnitOfWork(appDb, {
    clock,
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const handlers: JobHandlers = {
    'content.publish': (job: JobRecord) =>
      uow.run(systemPrincipal(job.tenantId!, 'jobs:content.publish'), (ctx) =>
        publishScheduled(ctx, parseJobPayload('content.publish', job.payload))
      ),
  };
  const worker = () => runJobs(operatorDb, handlers, { types: ['content.publish'], batchSize: 50 });
  let tenantA = '';
  let tenantB = '';
  const a = (): Principal => systemPrincipal(tenantA, 'test');

  const doc = (title: string) => ({
    type: 'page' as const,
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl: title, en: title },
    blocks: [],
  });
  const create = async (slug: string, p = a()) =>
    invoker.run(useCases.createItem, p, { slug: `${slug}-${run}`, document: doc(slug) });
  const state = async (itemId: string, locale: string) =>
    (await invoker.run(useCases.getItem, a(), { itemId })).item.publication.find(
      (s) => s.locale === locale
    )!;
  const plan = (itemId: string, revisionId: string, locale: string, minutes = 1) =>
    invoker.run(useCases.scheduleItem, a(), {
      itemId,
      revisionId,
      locale,
      at: new Date(clock.now().getTime() + minutes * MINUTE).toISOString(),
    });
  const save = async (itemId: string, title: string) => {
    const { item } = await invoker.run(useCases.getItem, a(), { itemId });
    return (
      await invoker.run(useCases.updateItem, a(), {
        itemId,
        baseRevisionId: item.latestRevisionId,
        document: doc(title),
      })
    ).revision.id;
  };
  /** The jobs of one item, read as the worker would. */
  const jobsOf = (itemId: string) =>
    operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_worker`.execute(trx);
      return trx
        .selectFrom('jobs')
        .selectAll()
        .where('key', 'like', `content.publish:${itemId}:%`)
        .orderBy('id')
        .execute();
    });
  const sqlState = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: { code?: string }) => e.code
    );

  beforeAll(async () => {
    await migrate(operatorUrl!, { log: () => {} });
    const tenant = (slug: string) =>
      upsertTenant(
        operatorDb,
        { id: uuidv7(), slug, name: slug, defaultLocale: 'nl', locales: ['nl', 'en'] },
        { platformDomain: 'localhost' }
      );
    tenantA = (await tenant(`c-a-${run}`)).id;
    tenantB = (await tenant(`c-b-${run}`)).id;
  });

  beforeEach(() => {
    clock.current = new Date(Date.now() - 60 * MINUTE);
  });

  afterAll(async () => {
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('retains an older scheduled pin through pending writes, refusal and human approval', async () => {
    const created = await create('pending-pin');
    await plan(created.item.id, created.revision.id, 'en');
    const pinned = await state(created.item.id, 'en');
    const pending = await invoker.run(useCases.updateItem, a(), {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: { ...created.revision.document, machineTranslation: { en: ['locales'] } },
    });
    const target = { itemId: created.item.id, revisionId: pending.revision.id, locale: 'en' };
    await expect(invoker.run(useCases.publishItem, a(), target)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      invoker.run(useCases.scheduleItem, a(), {
        ...target,
        at: new Date(clock.now().getTime() + MINUTE).toISOString(),
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const human = {
      ...a(),
      actor: { kind: 'operator' as const, operatorId: uuidv7(), email: 'reviewer@probe.test' },
    };
    const approved = await invoker.run(useCases.approveTranslation, human, {
      itemId: created.item.id,
      baseRevisionId: pending.revision.id,
      locale: 'en',
    });
    expect(await state(created.item.id, 'en')).toMatchObject({
      ...pinned,
      hasUnpublishedChanges: false,
    });
    const latest = await invoker.run(useCases.getItem, a(), { itemId: created.item.id });
    expect(latest.revision.id).toBe(approved.revisionId);
    expect(latest.revision.document.machineTranslation).toBeUndefined();
    expect(latest.revision.document.blocks).toEqual(created.revision.document.blocks);
  });

  it('round-trips items, revisions, authors, sections and patterns, per tenant', async () => {
    const author = await invoker.run(useCases.createAuthor, a(), {
      slug: `sam-${run}`,
      name: 'Sam',
      bio: { nl: 'Verslaggever' },
      links: [{ label: 'Site', url: 'https://example.org/' }],
      email: 'sam@example.org',
    });
    const section = await invoker.run(useCases.createSection, a(), {
      slug: `politiek-${run}`,
      title: { nl: 'Politiek' },
      order: 2,
    });
    const pattern = await invoker.run(useCases.createPattern, a(), {
      name: { nl: 'Interview' },
      intendedType: 'article',
      blocks: [{ type: 'heading', version: 1, props: { text: { nl: 'Vraag' } } }],
    });
    const created = await invoker.run(useCases.createItem, a(), {
      slug: `story-${run}`,
      patternId: pattern.id,
      document: {
        ...doc('Verhaal'),
        type: 'article',
        lead: { nl: 'Intro', en: 'Intro' },
        authorIds: [author.id],
        sectionId: section.id,
        tags: ['Klimaat', 'klimaat'],
        corrections: [{ date: '2026-10-22', text: { nl: 'Gecorrigeerd', en: 'Corrected' } }],
        delivery: { web: true, email: { listId: 'newsletter', subject: { nl: 'S', en: 'S' } } },
        seo: { title: { nl: 'Zoek' }, noindex: true, canonical: 'https://example.org/x' },
      },
    });
    expect(await invoker.run(useCases.getItem, a(), { itemId: created.item.id })).toEqual(created);
    expect(await invoker.run(useCases.getAuthor, a(), { authorId: author.id })).toEqual(author);
    expect(await invoker.run(useCases.getSection, a(), { sectionId: section.id })).toEqual(section);
    expect(await invoker.run(useCases.getPattern, a(), { patternId: pattern.id })).toEqual(pattern);
    expect(created.revision.document).toMatchObject({ tags: ['klimaat'] });

    // Tenant B sees none of it, and cannot reference A's author by its id.
    const b = systemPrincipal(tenantB, 'test');
    await expect(
      invoker.run(useCases.getItem, b, { itemId: created.item.id })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      invoker.run(useCases.createItem, b, {
        slug: `story-${run}`,
        document: { ...doc('x'), type: 'article', authorIds: [author.id] },
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('makes a save wait for an open item lock and then see the newer base', async () => {
    // Deterministic counterpart of the race below: one transaction holds the row lock and saves
    // a revision behind a gate; a second save on the same base cannot run until it commits, and
    // then finds the base stale. Without `select ... for update` the second save would commit
    // first and the first would overwrite its latest pointer.
    const { item, revision } = await create('lock-hold');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = uow.run(a(), async (ctx) => {
      await ctx.content.lock(item.id);
      await gate;
      await useCases.updateItem.handler(ctx, {
        itemId: item.id,
        baseRevisionId: revision.id,
        document: doc('held'),
      });
    });
    let settled = false;
    const second = invoker
      .run(useCases.updateItem, a(), {
        itemId: item.id,
        baseRevisionId: revision.id,
        document: doc('second'),
      })
      .finally(() => (settled = true));
    second.catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    release();
    await holder;
    await expect(second).rejects.toMatchObject({ code: 'conflict' });
    const { revisions } = await invoker.run(useCases.listRevisions, a(), { itemId: item.id });
    expect(revisions).toHaveLength(2);
  });

  it('lets exactly one of concurrent saves on one base win, with no orphan revision', async () => {
    // Eight at once: two alone tend to serialise on connection checkout and would pass without
    // the lock too.
    for (let round = 0; round < 3; round++) {
      const { item, revision } = await create(`race-save-${round}`);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          invoker.run(useCases.updateItem, a(), {
            itemId: item.id,
            baseRevisionId: revision.id,
            document: doc(`save ${i}`),
          })
        )
      );
      const won = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
        revision: { id: string };
      }>[];
      const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(won).toHaveLength(1);
      for (const l of lost) expect(l.reason).toMatchObject({ code: 'conflict' });
      const { revisions } = await invoker.run(useCases.listRevisions, a(), { itemId: item.id });
      expect(revisions.map((r) => r.id)).toEqual([won[0]!.value.revision.id, revision.id]);
    }
  });

  it('keeps revisions immutable and pins relational for mycel_app', async () => {
    const one = await create('pin-one');
    const two = await create('pin-two');
    const asApp = (q: (trx: typeof appDb) => Promise<unknown>) =>
      sqlState(withTenant(appDb, a(), (trx) => q(trx)));
    expect(
      await asApp((trx) =>
        sql`update content_revisions set document = '{}' where id = ${one.revision.id}`.execute(trx)
      )
    ).toBe('42501');
    expect(
      await asApp((trx) =>
        sql`delete from content_revisions where id = ${one.revision.id}`.execute(trx)
      )
    ).toBe('42501');
    // Another item's revision cannot be this item's live revision.
    expect(
      await asApp((trx) =>
        sql`update content_item_locales
            set published_revision_id = ${two.revision.id}, published_at = now(),
                first_published_at = now()
            where item_id = ${one.item.id} and locale = 'nl'`.execute(trx)
      )
    ).toBe('23503');
    // A pin without its time and id, or a pointer without a date, is refused.
    expect(
      await asApp((trx) =>
        sql`update content_item_locales set scheduled_revision_id = ${one.revision.id}
            where item_id = ${one.item.id} and locale = 'nl'`.execute(trx)
      )
    ).toBe('23514');
  });

  it('publishes nl and keeps the en draft out of the public projection', async () => {
    const { item, revision } = await invoker.run(useCases.createItem, a(), {
      slug: `bilingual-${run}`,
      document: {
        ...doc('Titel'),
        blocks: [
          { type: 'heading', version: 1, props: { text: { nl: 'Kop', en: 'EN-DRAFT-MARKER' } } },
        ],
      },
    });
    await invoker.run(useCases.publishItem, a(), {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
    const visitor = anonymousPrincipal(tenantA, ['content:read']);
    const page = await invoker.run(useCases.getPublished, visitor, {
      type: 'page',
      slug: `bilingual-${run}`,
    });
    expect(page.locale).toBe('nl');
    expect(JSON.stringify(page)).not.toContain('EN-DRAFT-MARKER');
    await expect(
      invoker.run(useCases.getPublished, visitor, {
        type: 'page',
        slug: `bilingual-${run}`,
        locale: 'en',
      })
    ).rejects.toMatchObject({ code: 'not_found' });
    const { rows } = await withTenant(appDb, a(), (trx) =>
      sql<{ locale: string; status: string }>`select locale, status from content_item_locales
        where item_id = ${item.id} order by locale`.execute(trx)
    );
    expect(rows).toEqual([
      { locale: 'en', status: 'draft' },
      { locale: 'nl', status: 'published' },
    ]);
  });

  describe('scheduled publication through the jobs worker', () => {
    it('publishes pinned revision A after B was saved, per locale', async () => {
      const { item, revision } = await create('sched');
      await plan(item.id, revision.id, 'nl', 1);
      await plan(item.id, revision.id, 'en', 3);
      const b = await save(item.id, 'B');
      clock.advance(2 * MINUTE);
      await worker();
      expect(await state(item.id, 'nl')).toMatchObject({
        status: 'published',
        publishedRevisionId: revision.id,
      });
      // en ran early: planned again at its pinned time, nothing published yet.
      expect((await state(item.id, 'en')).status).toBe('scheduled');
      clock.advance(2 * MINUTE);
      await worker();
      expect(await state(item.id, 'en')).toMatchObject({
        status: 'published',
        publishedRevisionId: revision.id,
      });
      expect(
        (await invoker.run(useCases.getItem, a(), { itemId: item.id })).item.latestRevisionId
      ).toBe(b);
      expect((await jobsOf(item.id)).every((j) => j.done_at !== null)).toBe(true);
    });

    it('re-pin, unschedule and manual publish leave the old jobs as no-ops', async () => {
      const { item, revision } = await create('repin');
      await plan(item.id, revision.id, 'nl', 1);
      await plan(item.id, revision.id, 'nl', 10); // same revision, new time
      clock.advance(2 * MINUTE);
      await worker();
      expect((await state(item.id, 'nl')).status).toBe('scheduled');

      await invoker.run(useCases.unscheduleItem, a(), { itemId: item.id, locale: 'nl' });
      const b = await save(item.id, 'B');
      await plan(item.id, b, 'en', 1);
      await invoker.run(useCases.publishItem, a(), {
        itemId: item.id,
        revisionId: revision.id,
        locale: 'en',
      });
      clock.advance(20 * MINUTE);
      await worker();
      expect((await state(item.id, 'nl')).status).toBe('draft');
      expect((await state(item.id, 'en')).publishedRevisionId).toBe(revision.id);
      expect((await jobsOf(item.id)).filter((j) => j.done_at === null)).toEqual([]);
    });

    it('a second delivery of a finished job publishes nothing again', async () => {
      const { item, revision } = await create('redeliver');
      await plan(item.id, revision.id, 'nl', 1);
      clock.advance(2 * MINUTE);
      await worker();
      const first = await state(item.id, 'nl');
      const [job] = await jobsOf(item.id);
      await invoker.run(useCases.unpublishItem, a(), { itemId: item.id, locale: 'nl' });
      await handlers['content.publish']!({ tenantId: tenantA, payload: job!.payload } as JobRecord);
      expect((await state(item.id, 'nl')).status).toBe('unpublished');
      expect(first.status).toBe('published');
    });

    it('an old job racing a reschedule follows the lock order, never publishing after the re-pin', async () => {
      for (let i = 0; i < 5; i++) {
        clock.current = new Date(Date.now() - 60 * MINUTE);
        const { item, revision } = await create(`race-${i}`);
        await plan(item.id, revision.id, 'nl', 1);
        clock.advance(2 * MINUTE);
        const [, resched] = await Promise.all([worker(), plan(item.id, revision.id, 'nl', 30)]);
        const s = await state(item.id, 'nl');
        // Either the old job ran first (live, and the new plan pending) or the re-pin did (old
        // job stale): the new plan always survives.
        expect(s.scheduleId).toBe(resched.publication.find((x) => x.locale === 'nl')!.scheduleId);
        expect([null, revision.id]).toContain(s.publishedRevisionId);
      }
    });

    it('a rolled-back schedule leaves neither a pin nor a job', async () => {
      const { item, revision } = await create('rollback');
      await expect(
        uow.run(a(), async (ctx) => {
          await scheduleItem.handler(ctx, {
            itemId: item.id,
            revisionId: revision.id,
            locale: 'nl',
            at: new Date(clock.now().getTime() + MINUTE).toISOString(),
          });
          throw new Error('after the schedule, before commit');
        })
      ).rejects.toThrow('before commit');
      expect((await state(item.id, 'nl')).scheduleId).toBeNull();
      expect(await jobsOf(item.id)).toEqual([]);
    });
  });
});
