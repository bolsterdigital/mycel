// Reader self-service in memory (ADR 016 rule 1, ADR 019 rule 7): a reader reads only their own
// account on the site of the session, withdraws from a list the way the unsubscribe link does,
// and the last sign-in survives a re-fold after retention removed the sign-in events. The
// Postgres side (RLS, the compaction policy, erasure of `last_seen_at`) is
// packages/db/src/supporters/reader-activity.test.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import { issueStartedToken } from '../forms/spam.js';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal, readerPrincipal, systemPrincipal } from '../principal.js';
import { SupporterEvent } from '../supporters/events.js';
import { ingest } from '../supporters/service.js';
import { FakeClock, MemoryUnitOfWork, TENANT } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { SIGNIN_FORM_SCOPE, signinToken } from './model.js';

const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const DAY = 24 * 60 * 60 * 1000;

describe('reader self-service', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  const system = (tenant = TENANT) => systemPrincipal(tenant, 'test');
  const admin = systemPrincipal(TENANT, 'test');

  /** Sign in through the real request and complete, without the mail: the link row is read back. */
  async function signIn(email: string, tenant = TENANT) {
    const startedToken = await issueStartedToken(uow.signer, SIGNIN_FORM_SCOPE, clock.now());
    clock.advance(5000);
    await invoker.run(useCases.requestSignin, anonymousPrincipal(tenant, ['content:read'], 'ip'), {
      email,
      locale: 'nl',
      spam: { honeypot: '', startedToken },
    });
    const link = [...uow.store.for(tenant).signinLinks.values()].at(-1)!;
    const done = await invoker.run(
      useCases.completeSignin,
      anonymousPrincipal(tenant, ['content:read']),
      { token: await signinToken(uow.signer, tenant, link) }
    );
    if (done.status !== 'signed_in') throw new Error(done.status);
    const { session } = await invoker.run(
      useCases.getReaderSession,
      anonymousPrincipal(tenant, ['content:read']),
      { token: done.sessionToken }
    );
    return readerPrincipal(tenant, session!.sessionId);
  }

  const subscribe = (email: string, list: string, confirmed: boolean, n: number, tenant = TENANT) =>
    uow.run(system(tenant), (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: `sub-${list}-${n}`,
          type: 'newsletter.subscribed',
          email,
          occurred_at: new Date(clock.now().getTime() - 60_000 + n).toISOString(),
          source: 'test',
          source_site: 'urn:test',
          source_ref: `test:${n}`,
          props: { list, confirmed },
        })
      )
    );
  const projection = (email: string, tenant = TENANT) =>
    uow.run(system(tenant), (ctx) => ctx.supporters.getProjection(email));

  beforeEach(() => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
  });

  it('shows the reader their own address, access, lists, last sign-in and the site’s term', async () => {
    await subscribe('ada@example.org', 'nieuwsbrief', true, 1);
    await subscribe('ada@example.org', 'acties', false, 2);
    const leden = await invoker.run(useCases.createAccessTier, admin, {
      slug: 'leden',
      name: { nl: 'Leden', en: 'Members' },
      order: 2,
    });
    const pers = await invoker.run(useCases.createAccessTier, admin, {
      slug: 'pers',
      name: { nl: 'Pers' },
      kind: 'paid',
      order: 1,
    });
    const supporterId = (await projection('ada@example.org'))!.id;
    // Within the twelve hours of the session, so the reader can still look when it ends.
    const until = new Date(clock.now().getTime() + 60 * 60 * 1000).toISOString();
    await invoker.run(useCases.createAccessGrant, admin, {
      supporterId,
      tierId: leden.id,
      kind: 'comp',
      reason: 'Persweek',
      until,
    });
    await invoker.run(useCases.createAccessGrant, admin, {
      supporterId,
      tierId: pers.id,
      kind: 'gift',
      reason: 'Cadeau',
    });

    const reader = await signIn('ada@example.org');
    const signedInAt = clock.now().toISOString();
    const account = await invoker.run(useCases.getReaderAccount, reader, {});
    expect(account).toMatchObject({
      email: 'ada@example.org',
      lastSeenAt: signedInAt,
      activityRetentionDays: 90,
      lists: [
        { list: 'nieuwsbrief', status: 'confirmed' },
        { list: 'acties', status: 'pending' },
      ],
    });
    // In the tiers' own order; the reason of a grant is never part of it.
    expect(account.access).toEqual([
      expect.objectContaining({ tierId: pers.id, kind: 'paid', grantKind: 'gift', until: null }),
      expect.objectContaining({ tierId: leden.id, name: { nl: 'Leden', en: 'Members' }, until }),
    ]);
    expect(JSON.stringify(account)).not.toContain('Persweek');
    expect(account.access.every((a) => a.standing)).toBe(true);

    // At `until` itself the grant is over; it stays listed, as expired.
    clock.current = new Date(until);
    const later = await invoker.run(useCases.getReaderAccount, reader, {});
    expect(later.access.find((a) => a.tierId === leden.id)?.standing).toBe(false);
  });

  it('reads the term the tenant set, also 0', async () => {
    const reader = await signIn('ada@example.org');
    await invoker.run(useCases.updateSiteRetention, admin, {
      baseVersion: 0,
      retention: { submissionMonths: 24, readerActivityDays: 0 },
    });
    expect(await invoker.run(useCases.getReaderAccount, reader, {})).toMatchObject({
      activityRetentionDays: 0,
    });
  });

  it('is nobody’s account after sign-out, and never the account of another site', async () => {
    const reader = await signIn('ada@example.org');
    // The same session id presented on another tenant names no session there.
    const elsewhere = readerPrincipal(
      OTHER,
      reader.actor.kind === 'reader' ? reader.actor.sessionId : ''
    );
    await expect(invoker.run(useCases.getReaderAccount, elsewhere, {})).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      invoker.run(useCases.withdrawReaderSubscription, elsewhere, { list: 'nieuwsbrief' })
    ).rejects.toMatchObject({ code: 'not_found' });

    await invoker.run(useCases.signoutReader, reader, {});
    await expect(invoker.run(useCases.getReaderAccount, reader, {})).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('is closed to anyone who is not the reader: an operator, a visitor, an agent', async () => {
    for (const p of [
      admin,
      anonymousPrincipal(TENANT, ['content:read']),
      systemPrincipal(TENANT, 'agent'),
    ])
      await expect(invoker.run(useCases.getReaderAccount, p, {})).rejects.toMatchObject({
        code: 'forbidden',
      });
  });

  it('withdraws from a confirmed or a pending list once, as the unsubscribe link does', async () => {
    await subscribe('ada@example.org', 'nieuwsbrief', true, 1);
    await subscribe('ada@example.org', 'acties', false, 2);
    // Another site's supporter with the same address and list is not touched.
    await subscribe('ada@example.org', 'nieuwsbrief', true, 3, OTHER);
    const reader = await signIn('ada@example.org');

    expect(
      await invoker.run(useCases.withdrawReaderSubscription, reader, { list: 'nieuwsbrief' })
    ).toEqual({ status: 'withdrawn' });
    expect(
      await invoker.run(useCases.withdrawReaderSubscription, reader, { list: 'acties' })
    ).toEqual({ status: 'withdrawn' });
    clock.advance(1);
    expect(
      await invoker.run(useCases.withdrawReaderSubscription, reader, { list: 'nieuwsbrief' })
    ).toEqual({ status: 'not_subscribed' });

    const after = (await projection('ada@example.org'))!;
    expect(after.lists).toEqual([]);
    expect(after.pendingLists).toEqual([]);
    const log = await uow.run(system(), (ctx) => ctx.supporters.eventsFor(after.id));
    expect(
      log.filter((e) => e.type === 'newsletter.unsubscribed').map((e) => e.props['via'])
    ).toEqual(['reader', 'reader']);
    expect((await projection('ada@example.org', OTHER))!.lists).toEqual(['nieuwsbrief']);
  });

  it('keeps the last sign-in when a late event re-folds a log that retention compacted', async () => {
    await signIn('ada@example.org');
    clock.advance(DAY);
    await signIn('ada@example.org');
    const last = clock.now().toISOString();
    const before = (await projection('ada@example.org'))!;
    expect(before.lastSeenAt).toBe(last);

    // Retention removes the sign-in events (packages/db/src/infra/retention.ts does this in
    // Postgres; here the log is cut by hand).
    const store = uow.store.for(TENANT);
    for (const [key, e] of store.events)
      if (e.type === 'reader.signed_in') store.events.delete(key);

    // A late subscription, older than everything folded, forces a re-fold from the cut log.
    await uow.run(system(), (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: 'late-1',
          type: 'newsletter.subscribed',
          email: 'ada@example.org',
          occurred_at: new Date(Date.parse(before.firstSeen) + 1).toISOString(),
          source: 'test',
          source_site: 'urn:test',
          source_ref: 'test:late',
          props: { list: 'nieuwsbrief', confirmed: true },
        })
      )
    );
    const after = (await projection('ada@example.org'))!;
    expect(after.lists).toEqual(['nieuwsbrief']);
    expect(after.lastSeenAt).toBe(last);
    expect(after.firstSeen).toBe(before.firstSeen);
    expect(after.lastActivity).toBe(before.lastActivity);
  });
});
