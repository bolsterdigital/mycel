// Newsletter editions against Postgres (migration 0070; ADR 018 rule 4, ADR 019 rules 5, 6 and
// 8). The memory suite (core `mailing/edition.test.ts`) proves what is sent to whom; this one
// proves what only the database can: the application role cannot change or delete what was
// sent, two workers on one edition make one provider call per recipient, the member page reads
// confirmed consent only and in id order, the intent rows hold no address, and an erasure takes
// the erased supporter's edition intent with it.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  DEFAULT_ACCESS,
  EDITION_SUBSCRIBER,
  Invoker,
  buildRegistry,
  deliverEdition,
  recipientIntentKey,
  useCases,
  type EditionMailDeps,
  type MailMessage,
  type Mailer,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  adminOf,
  memoryPlatform,
  pageDocument,
  runSuffix,
} from '@mycel/core/testing';
import {
  applyErasures,
  createDb,
  createTenantDirectory,
  createUnitOfWork,
  uuidv7,
  uuidv7Ids,
  withTenant,
} from './index.js';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

const SITE = { name: 'M', url: 'http://localhost:5173/m', defaultLocale: 'nl' };
const LIST = 'newsletter';

class RecordingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  readonly keys: string[] = [];
  async send(message: MailMessage, key: string) {
    this.sent.push(message);
    this.keys.push(key);
    // Long enough for a second worker to meet the claim in flight.
    await new Promise((r) => setTimeout(r, 20));
    return { providerId: `p-${this.sent.length}` };
  }
  async lookup() {
    return { providerIds: this.sent.map((_m, i) => `p-${i + 1}`) };
  }
}

describe.skipIf(skip)('mail editions over Postgres', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const appDb2 = createDb(appUrl);
  const clock = { now: () => new Date() };
  const signer = new FakeSigner();
  const uowOn = (db: typeof appDb) =>
    createUnitOfWork(db, {
      clock,
      ids: uuidv7Ids,
      signer,
      connectionCredentialKey: 'ab'.repeat(32),
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns(),
      platform: memoryPlatform,
      emailRenderer: {
        render: (e) => ({
          html: `<h1>${e.title}</h1><a href="${e.unsubscribe?.href}">x</a>`,
          text: `${e.title} ${e.unsubscribe?.href}`,
        }),
      },
    });
  const uow = uowOn(appDb);
  const invoker = new Invoker(buildRegistry(), uow);
  const run = runSuffix();
  let tenantId = '';
  let itemId = '';
  const members: { id: string; email: string }[] = [];

  const depsOn = (mailer: Mailer, db: typeof appDb): EditionMailDeps => ({
    mailer,
    signer,
    clock,
    tenants: createTenantDirectory(appDb),
    uow: uowOn(db),
    from: { email: 'noreply@example.org' },
    platform: memoryPlatform,
    access: async () => DEFAULT_ACCESS,
    reconcileLagMs: 0,
  });
  const supporter = async (name: string, lists: string[], pendingLists: string[] = []) => {
    const row = { id: uuidv7(), email: `${name}-${run}@example.org` };
    const at = new Date().toISOString();
    await uow.run(adminOf(tenantId), (ctx) =>
      ctx.supporters.saveProjection({
        ...row,
        lists,
        pendingLists,
        grants: [],
        lastSeenAt: null,
        firstSeen: at,
        lastActivity: at,
        appliedThrough: { at, id: 'fixture' },
      })
    );
    return row;
  };
  const send = () =>
    invoker.run(useCases.sendEdition, adminOf(tenantId), { itemId, locales: ['nl'], site: SITE });
  const intents = async (editionId: string) =>
    (
      await withTenant(appDb, adminOf(tenantId), (trx) =>
        trx
          .selectFrom('mail_sends')
          .selectAll()
          .where('event_id', '=', editionId)
          .orderBy('key')
          .execute()
      )
    ).map((r) => r.key);

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    tenantId = (await testTenant(operatorDb, `editions-${run}`, { name: 'M' })).id;
    const admin = adminOf(tenantId);
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug: `edition-${run}`,
      document: {
        ...pageDocument({ title: { nl: 'Nieuws', en: 'News' } }),
        type: 'article' as const,
        delivery: { email: { listId: LIST, subject: { nl: 'Het nieuws' } } },
      },
    });
    itemId = item.id;
    await invoker.run(useCases.publishItem, admin, {
      itemId,
      revisionId: revision.id,
      locale: 'nl',
    });
    members.push(await supporter('ada', [LIST]), await supporter('bob', [LIST, 'events']));
    await supporter('pending', [], [LIST]);
    await supporter('other', ['events']);
  });

  afterAll(async () => {
    await closeTenantWork(operatorDb, [tenantId]);
    await operatorDb.destroy();
    await appDb.destroy();
    await appDb2.destroy();
  });

  it('reads confirmed members only, in id order and page by page', async () => {
    const ids = members.map((m) => m.id).sort();
    const page = (after: string | null, limit: number) =>
      uow.run(adminOf(tenantId), async (ctx) =>
        (await ctx.supporters.members(LIST, { after, limit })).map((p) => p.id)
      );
    expect(await page(null, 10)).toEqual(ids);
    expect(await page(null, 1)).toEqual([ids[0]]);
    expect(await page(ids[0]!, 10)).toEqual([ids[1]]);
    expect(await uow.run(adminOf(tenantId), (ctx) => ctx.supporters.countMembers(LIST))).toBe(2);
  });

  it('keeps an edition as it was sent: the application role cannot change or delete it', async () => {
    const { editionId, recipients } = await send();
    expect(recipients).toBe(2);
    const attempt = (statement: ReturnType<typeof sql>) =>
      withTenant(appDb, adminOf(tenantId), (trx) => statement.execute(trx));
    for (const column of ['html', 'text', 'subject', 'revision_id', 'list', 'recipients'])
      await expect(
        attempt(sql`update mail_editions set ${sql.ref(column)} = ${sql.ref(column)}
                    where id = ${editionId}`)
      ).rejects.toThrow(/permission denied/);
    await expect(attempt(sql`delete from mail_editions where id = ${editionId}`)).rejects.toThrow(
      /permission denied/
    );
    // The delivery's two columns are the whole of what moves.
    await uow.run(adminOf(tenantId), (ctx) => ctx.mailEditions.advance(editionId, members[0]!.id));
    expect(
      await uow.run(adminOf(tenantId), (ctx) => ctx.mailEditions.get(editionId))
    ).toMatchObject({ deliveredThrough: members[0]!.id, completedAt: null, recipients: 2 });
    // The list of the item's editions carries the subject, not the mail.
    const listed = await uow.run(adminOf(tenantId), (ctx) => ctx.mailEditions.forItem(itemId));
    expect(listed[0]).toEqual({
      id: editionId,
      itemId,
      list: LIST,
      recipients: 2,
      sentAt: expect.any(Date),
      completedAt: null,
      locales: [{ locale: 'nl', subject: 'Het nieuws' }],
    });
  });

  it('makes one provider call per recipient when two workers run one edition', async () => {
    const { editionId } = await send();
    const mailer = new RecordingMailer();
    await Promise.all([
      deliverEdition(depsOn(mailer, appDb), tenantId, editionId),
      deliverEdition(depsOn(mailer, appDb2), tenantId, editionId),
    ]);
    // A run that met a claim in flight leaves it to that claim; a later run finds it sent.
    await deliverEdition(depsOn(mailer, appDb), tenantId, editionId);
    const expected = members
      .map((m) => recipientIntentKey(EDITION_SUBSCRIBER, m.id, editionId))
      .sort();
    expect([...mailer.keys].sort()).toEqual(expected);
    expect(await intents(editionId)).toEqual(expected);
    expect(mailer.sent.map((m) => m.to.email).sort()).toEqual(members.map((m) => m.email).sort());

    // No address in the intent rows or in the edition: ids and a hash only.
    const rows = await withTenant(appDb, adminOf(tenantId), async (trx) => [
      ...(await trx
        .selectFrom('mail_sends')
        .selectAll()
        .where('event_id', '=', editionId)
        .execute()),
      ...(await trx.selectFrom('mail_editions').selectAll().where('id', '=', editionId).execute()),
    ]);
    expect(JSON.stringify(rows)).not.toContain('@example.org');
  });

  it("deletes an erased supporter's edition intent and sends them no later edition", async () => {
    const eve = await supporter('eve', [LIST]);
    const first = await send();
    const mailer = new RecordingMailer();
    await deliverEdition(depsOn(mailer, appDb), tenantId, first.editionId);
    const hers = recipientIntentKey(EDITION_SUBSCRIBER, eve.id, first.editionId);
    expect(await intents(first.editionId)).toContain(hers);

    await invoker.run(useCases.eraseSupporter, adminOf(tenantId), { supporterId: eve.id });
    await applyErasures(operatorDb, tenantId);
    const left = await intents(first.editionId);
    expect(left).not.toContain(hers);
    expect(left).toHaveLength(2);
    expect(await applyErasures(operatorDb, tenantId)).toBe(0);

    const second = await send();
    expect(second.recipients).toBe(2);
    await deliverEdition(depsOn(mailer, appDb), tenantId, second.editionId);
    expect(mailer.sent.filter((m) => m.to.email === eve.email)).toHaveLength(1);
  });
});
