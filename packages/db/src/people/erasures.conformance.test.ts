// Person erasure against Postgres (ADR 034, migration 0050). The same person is author and
// photographer in nl and en, in a current, a historical and a trashed revision, a pattern, a bulk
// plan and a media credit, and a member of a group; after `content.person.erase` and apply the
// name and the contact data are in no row of the tenant, the ids stay, a second person and another
// tenant with the same name keep theirs, and a second apply changes nothing. What memory cannot
// prove is here too: the grants (the app role still cannot rewrite history, the eraser only the
// JSON column), a restore that brings the person back, and a write racing the registration.
// packages/core/src/content/people/erasure.test.ts holds the memory adapter to the same contract.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { EXAMPLE_PNG, Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryBlobStore,
  adminOf,
  memoryImageProcessor,
  memoryPlatform,
  pauseMedia,
  runSuffix,
} from '@mycel/core/testing';
import { applyErasures, createDb, createUnitOfWork, uuidv7Ids } from '../index.js';
import { asRole } from '../infra/roles.js';
import { migrateSchema, requireDatabase, testTenant } from '../testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

describe.skipIf(skip)('person erasure conformance', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const run = runSuffix();
  const SAM = `Sam Wis ${run}`;
  const KIM = `Kim Blijf ${run}`;
  const clock = { now: () => new Date() };
  const uow = createUnitOfWork(appDb, {
    clock,
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
    media: { blobs: new MemoryBlobStore(clock), images: memoryImageProcessor },
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const t = { a: '', b: '' };
  const ids = { sam: '', kim: '', item: '', trashed: '', photo: '', plan: '', samB: '' };
  const admin = () => adminOf(t.a);

  const credit = (personId: string, name: string) => ({
    work: null,
    photographer: name,
    photographerPersonId: personId,
  });
  const image = (id: string, personId: string, name: string) => ({
    id,
    type: 'image' as const,
    version: 1 as const,
    props: {
      mediaId: ids.photo,
      decorative: false,
      alt: { nl: 'Foto', en: 'Photo' },
      credit: credit(personId, name),
    },
  });
  const article = (title: string, blocks: object[], authorIds: string[]) => ({
    type: 'article' as const,
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl: `${title} nl`, en: `${title} en` },
    lead: { nl: 'Intro', en: 'Intro' },
    authorIds,
    blocks: blocks as never,
  });
  const story = (title: string) =>
    article(title, [image('a1', ids.sam, SAM), image('a2', ids.kim, KIM)], [ids.sam, ids.kim]);
  const latest = async (itemId = ids.item) =>
    (await invoker.run(useCases.getItem, admin(), { itemId })).revision;

  /** Every row of the tenant as text, from every table with a tenant_id the app role reads. */
  async function rowsOf(tenantId: string): Promise<string> {
    const tables = (
      await sql<{ name: string }>`
        select c.relname as name from pg_class c join pg_attribute a on a.attrelid = c.oid
        where a.attname = 'tenant_id' and not a.attisdropped and c.relkind = 'r'
          and c.relnamespace = 'public'::regnamespace and not c.relispartition
          and has_table_privilege('mycel_app', c.oid, 'SELECT')
        order by 1`.execute(operatorDb)
    ).rows.map((r) => r.name);
    const out: string[] = [];
    for (const table of tables)
      out.push(
        ...(await asRole(operatorDb, 'mycel_app', async (trx) => {
          await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
          const { rows } = await sql<{ row: string }>`
            select t::text as row from ${sql.table(table)} t`.execute(trx);
          return rows.map((r) => `${table}: ${r.row}`);
        }))
      );
    return out.join('\n');
  }

  async function person(tenant: string, slug: string, name: string) {
    return (
      await invoker.run(useCases.createPerson, adminOf(tenant), {
        slug,
        name,
        email: `${slug}-${run}@example.org`,
        bio: { nl: `${name} bio`, en: `${name} bio` },
      })
    ).id;
  }

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    t.a = (await testTenant(operatorDb, `perase-a-${run}`)).id;
    t.b = (await testTenant(operatorDb, `perase-b-${run}`)).id;
    ids.sam = await person(t.a, 'sam', SAM);
    ids.kim = await person(t.a, 'kim', KIM);
    ids.samB = await person(t.b, 'sam', SAM);
    ids.photo = (
      await invoker.run(useCases.uploadMedia, admin(), {
        filename: 'p.png',
        contentType: 'image/png',
        bytes: EXAMPLE_PNG,
        credit: credit(ids.sam, SAM),
      })
    ).id;
    await invoker.run(useCases.createPersonGroup, admin(), {
      name: { nl: 'Team' },
      personIds: [ids.sam, ids.kim],
    });
    const created = await invoker.run(useCases.createItem, admin(), {
      slug: `story-${run}`,
      document: story('Story'),
    });
    ids.item = created.item.id;
    await invoker.run(useCases.updateItem, admin(), {
      itemId: ids.item,
      baseRevisionId: created.revision.id,
      document: story('Story v2'),
    });
    await invoker.run(useCases.createPattern, admin(), {
      name: { nl: 'Portret' },
      intendedType: 'article',
      blocks: [image('p1', ids.sam, SAM) as never],
    });
    const base = await latest();
    ids.plan = (
      await invoker.run(useCases.createBulk, admin(), {
        locale: 'nl',
        items: [
          {
            itemId: ids.item,
            baseRevisionId: base.id,
            operation: { kind: 'save', document: story('Bulk') },
          },
        ],
      })
    ).id;
    ids.trashed = (
      await invoker.run(useCases.createItem, admin(), {
        slug: `old-${run}`,
        document: article('Old', [image('t1', ids.sam, SAM)], [ids.sam]),
      })
    ).item.id;
    await invoker.run(useCases.deleteItem, admin(), { itemId: ids.trashed });
  });

  afterAll(async () => {
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('refuses an unknown or foreign id whole and registers nothing', async () => {
    await expect(
      invoker.run(useCases.erasePeople, admin(), { personIds: [ids.sam, ids.samB] })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(
      await uow.run(admin(), (ctx) => ctx.personErasures.registered([ids.sam, ids.samB]))
    ).toEqual(new Set());
  });

  it('keeps the app role from rewriting history and the eraser to the JSON column', async () => {
    const attempt = (role: 'mycel_app' | 'mycel_erasure', statement: ReturnType<typeof sql>) =>
      asRole(operatorDb, role, async (trx) => {
        await sql`select set_config('app.tenant_id', ${t.a}, true)`.execute(trx);
        await statement.execute(trx);
      });
    for (const statement of [
      sql`update content_revisions set document = document`,
      sql`update content_bulk_plan_items set preview = preview`,
      sql`delete from people`,
      sql`update person_erasures set erased_at = now()`,
      sql`delete from person_erasures`,
    ])
      await expect(attempt('mycel_app', statement)).rejects.toThrow(/permission denied/);
    for (const statement of [
      sql`update content_revisions set actor = actor`,
      sql`update content_revisions set item_id = item_id`,
      sql`update patterns set name = name`,
      sql`update media set caption = caption`,
      sql`update people set name = name`,
      sql`insert into person_erasures (tenant_id, person_id, actor) values (${t.a}, ${ids.kim}, '{}')`,
    ])
      await expect(attempt('mycel_erasure', statement)).rejects.toThrow(/permission denied/);
  });

  it('registers, plans the job, applies everywhere and leaves the rest alone', async () => {
    const before = await rowsOf(t.a);
    expect(before).toContain(SAM);
    const result = await invoker.run(useCases.erasePeople, admin(), { personIds: [ids.sam] });
    expect(result).toMatchObject({
      created: [ids.sam],
      people: [{ personId: ids.sam, applied: false }],
      notErased: ['text-mentions', 'image-pixels'],
    });
    const jobs = await asRole(operatorDb, 'mycel_worker', (trx) =>
      sql<{ key: string }>`select key from jobs where tenant_id = ${t.a}
        and type = 'person.erase'`.execute(trx)
    );
    expect(jobs.rows.map((r) => r.key)).toEqual([`person.erase:${ids.sam}`]);

    expect(await applyErasures(operatorDb, t.a)).toBeGreaterThan(0);
    const after = await rowsOf(t.a);
    expect(after).not.toContain(SAM);
    expect(after).not.toContain(`sam-${run}@example.org`);
    expect(after).toContain(ids.sam);
    expect(after).toContain(KIM);
    for (const table of ['content_revisions', 'patterns', 'content_bulk_plan_items', 'media'])
      expect(after, table).toMatch(new RegExp(`^${table}: .*${ids.sam}`, 'm'));
    expect(await rowsOf(t.b)).toContain(SAM);
    expect(await applyErasures(operatorDb, t.a)).toBe(0);
    const again = await invoker.run(useCases.erasePeople, admin(), { personIds: [ids.sam] });
    expect(again).toMatchObject({ created: [], people: [{ applied: true }] });
  });

  it('saves, publishes, applies and undoes with the registered id and stores no name', async () => {
    const first = (
      await invoker.run(useCases.listRevisions, admin(), { itemId: ids.item })
    ).revisions.at(-1)!;
    // A stale tab: the first revision as base, the old name beside the registered id.
    const saved = await invoker.run(useCases.updateItem, admin(), {
      itemId: ids.item,
      baseRevisionId: first.id,
      document: story('Story'),
    });
    expect(JSON.stringify(saved.revision.document)).not.toContain(SAM);
    await invoker.run(useCases.publishItem, admin(), {
      itemId: ids.item,
      revisionId: saved.revision.id,
      locale: 'nl',
    });
    const step = { planId: ids.plan, version: 1 as const, ordinal: 0 };
    await invoker.run(useCases.resumeBulk, admin(), step);
    expect((await invoker.run(useCases.withdrawBulk, admin(), step)).result.status).toBe('undone');
    const media = await invoker.run(useCases.updateMedia, admin(), {
      id: ids.photo,
      credit: credit(ids.sam, SAM),
    });
    expect(media.credit.photographer).toBeNull();
    await expect(
      invoker.run(useCases.updateItem, admin(), {
        itemId: ids.item,
        baseRevisionId: (await latest()).id,
        document: article('Unknown', [], [uuidv7Ids.next()]),
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await rowsOf(t.a)).not.toContain(SAM);
  });

  it('erases again what a restore of an older backup brings back', async () => {
    // As a restore would: the person row and an old revision with the name are back, the
    // register comes from the newer erasures snapshot (restore-erasures.sh).
    const revision = (await latest()).id;
    await asRole(operatorDb, 'mycel_app', async (trx) => {
      await sql`select set_config('app.tenant_id', ${t.a}, true)`.execute(trx);
      await sql`insert into people (id, tenant_id, slug, name, email, created_at, updated_at)
        values (${ids.sam}, ${t.a}, 'sam', ${SAM}, ${`sam-${run}@example.org`}, now(), now())`.execute(
        trx
      );
    });
    await asRole(operatorDb, 'mycel_erasure', async (trx) => {
      await sql`select set_config('app.tenant_id', ${t.a}, true)`.execute(trx);
      await sql`update content_revisions set document = jsonb_set(document,
        '{blocks,0,props,credit,photographer}', ${JSON.stringify(SAM)}::jsonb)
        where id = ${revision}`.execute(trx);
    });
    expect(await rowsOf(t.a)).toContain(SAM);
    expect(await applyErasures(operatorDb, t.a)).toBe(2);
    expect(await rowsOf(t.a)).not.toContain(SAM);
  });

  it('serialises a credit write with a registration in both orders', async () => {
    const other = await person(t.a, `race-${run}`, `Race ${run}`);
    const raced = await invoker.run(useCases.createItem, admin(), {
      slug: `race-${run}`,
      document: article('Race', [], [ids.kim]),
    });
    const write = (u = uow) =>
      new Invoker(buildRegistry(), u).run(useCases.updateItem, admin(), {
        itemId: raced.item.id,
        baseRevisionId: raced.revision.id,
        document: article('Race', [image('r1', other, `Race ${run}`)], [ids.kim]),
      });
    // Registration first: the write waits on the lock and then stores no name.
    let release!: () => void;
    let reached!: () => void;
    const holding = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    const registration = uow.run(admin(), async (ctx) => {
      await ctx.personErasures.register([other]);
      reached();
      await gate;
    });
    await holding;
    let settled = false;
    const saving = write().finally(() => (settled = true));
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);
    release();
    await registration;
    const saved = await saving;
    expect(JSON.stringify(saved.revision.document)).not.toContain(`Race ${run}`);

    // Write first: a registration waits until the write commits; apply then scrubs it.
    const third = await person(t.a, `late-${run}`, `Late ${run}`);
    const paused = pauseMedia(uow, 'replaceUsages');
    const late = new Invoker(buildRegistry(), paused.uow).run(useCases.updateItem, admin(), {
      itemId: raced.item.id,
      baseRevisionId: saved.revision.id,
      document: article('Race', [image('r1', third, `Late ${run}`)], [ids.kim]),
    });
    await paused.reached;
    let registered = false;
    const registering = invoker
      .run(useCases.erasePeople, systemPrincipal(t.a, 'test'), { personIds: [third] })
      .finally(() => (registered = true));
    await new Promise((r) => setTimeout(r, 150));
    expect(registered).toBe(false);
    paused.release();
    expect(JSON.stringify((await late).revision.document)).toContain(`Late ${run}`);
    await registering;
    await applyErasures(operatorDb, t.a);
    expect(await rowsOf(t.a)).not.toContain(`Late ${run}`);
  });
  it('erases an id stored in upper case and keeps the document savable', async () => {
    // The input accepts a guid in any case and `uuid` compares regardless, so a stored copy can
    // spell the id in upper case; the register holds it lower case.
    const NAME = `Ula Hoog ${run}`;
    const lower = await person(t.a, `ula-${run}`, NAME);
    const upper = lower.toUpperCase();
    const photo = (
      await invoker.run(useCases.uploadMedia, admin(), {
        filename: 'u.png',
        contentType: 'image/png',
        bytes: EXAMPLE_PNG,
        credit: credit(upper, NAME),
      })
    ).id;
    const doc = () => article('Hoog', [image('u1', upper, NAME)], [upper]);
    const created = await invoker.run(useCases.createItem, admin(), {
      slug: `upper-${run}`,
      document: doc(),
    });
    expect(JSON.stringify(created.revision.document)).toContain(upper);
    await invoker.run(useCases.erasePeople, admin(), { personIds: [upper] });
    await applyErasures(operatorDb, t.a);
    expect(await rowsOf(t.a)).not.toContain(NAME);
    expect(await applyErasures(operatorDb, t.a)).toBe(0);
    // A stale tab: the old base, the name beside the upper-case id; saved without the name.
    const saved = await invoker.run(useCases.updateItem, admin(), {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: doc(),
    });
    expect(saved.revision.document.blocks[0]).toMatchObject({
      props: { credit: { photographer: null, photographerPersonId: upper } },
    });
    const media = await invoker.run(useCases.updateMedia, admin(), {
      id: photo,
      credit: credit(upper, NAME),
    });
    expect(media.credit.photographer).toBeNull();
    expect(await rowsOf(t.a)).not.toContain(NAME);
  });
});
