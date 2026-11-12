// Participation and the counter (ADR 033 rules 3, 7 and 8) over the memory adapter: the
// submit path decides under the campaign, the confirmation makes a signature count, ingest records
// it once per supporter, erasure moves it into the anonymous count. The Postgres side of the same
// rows is `packages/db/src/campaigns/participation.test.ts`.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal } from '../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT, expectCode, principal } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { signConfirmToken } from '../mailing/confirmation.js';
import { supporterIngestSubscriber } from '../supporters/service.js';
import { PARTICIPATION_REQUESTED } from '../forms/events.js';

const HOUR = 3600_000;

async function setup(kind: 'petition' | 'signup' = 'petition') {
  const clock = new FakeClock();
  const uow = new MemoryUnitOfWork({ clock });
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = principal({
    capabilities: [
      'content:read',
      'content:write',
      'content:publish',
      'forms:write',
      'forms:read',
      'supporters:read',
      'supporters:write',
      'supporters:erase',
    ],
  });
  const { item } = await invoker.run(useCases.createItem, admin, {
    slug: 'teken',
    document: {
      type: 'page',
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      title: { nl: 'Teken', en: 'Sign' },
      blocks: [],
    } as never,
  });
  const publish = (locale = 'nl') =>
    invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: item.latestRevisionId,
      locale,
    });
  const form = await invoker.run(useCases.createForm, admin, { kind });
  let campaign = await invoker.run(useCases.createCampaign, admin, {
    kind,
    landingItemId: item.id,
    formId: form.id,
  });
  const open = async () =>
    (campaign = await invoker.run(useCases.openCampaign, admin, {
      campaignId: campaign.id,
      baseUpdatedAt: campaign.updatedAt,
    }));
  const close = async () =>
    (campaign = await invoker.run(useCases.closeCampaign, admin, {
      campaignId: campaign.id,
      baseUpdatedAt: campaign.updatedAt,
    }));
  const sign = (email: string, consent = false, locale = 'nl') =>
    invoker.run(useCases.submitForm, admin, {
      formId: form.id,
      values: { email, consent },
      locale,
    });
  const confirm = async (submissionId: string) =>
    invoker.run(useCases.confirmSubscription, admin, {
      token: await signConfirmToken(
        uow.signer,
        { tenantId: TENANT, submissionId, list: form.list },
        clock.now()
      ),
    });
  const ingest = supporterIngestSubscriber(uow);
  /** Deliver what the outbox holds to supporter ingest, as the worker would after commit. */
  const drain = async () => {
    const events = uow.store.outbox.filter((e) => ingest.types.includes(e.type));
    uow.store.outbox.length = 0;
    for (const e of events) await ingest.handle(e);
    return events;
  };
  const count = async () =>
    (await invoker.run(useCases.getCampaign, admin, { campaignId: campaign.id })).participants;
  const supporterOf = (email: string) =>
    uow.run(systemPrincipal(TENANT, 'test'), (ctx) => ctx.supporters.getProjection(email));
  /** Sign, confirm and ingest: one counted participation. */
  const signAndConfirm = async (email: string, consent = false) => {
    const r = await sign(email, consent);
    if (r.status !== 'accepted') throw new Error(r.status);
    await drain();
    await confirm(r.submissionId);
    await drain();
    return r.submissionId;
  };
  return {
    clock,
    uow,
    invoker,
    admin,
    form,
    item,
    publish,
    open,
    close,
    sign,
    confirm,
    drain,
    count,
    supporterOf,
    signAndConfirm,
    campaign: () => campaign,
  };
}

describe('campaign participation (ADR 033)', () => {
  it('counts a confirmed signature once, and an unconfirmed one not at all', async () => {
    const t = await setup();
    await t.publish();
    await t.open();
    const r = await t.sign('ada@example.org');
    if (r.status !== 'accepted') throw new Error(r.status);
    // Submitted, not yet confirmed: nothing for ingest, nothing counted.
    expect(await t.drain()).toEqual([]);
    expect(await t.count()).toBe(0);

    expect(await t.confirm(r.submissionId)).toEqual({
      status: 'confirmed',
      locale: 'nl',
      purpose: 'participation',
    });
    const signed = await t.drain();
    expect(signed.map((e) => e.type)).toEqual(['petition.signed']);
    expect(signed[0]?.props).toMatchObject({ campaignId: t.campaign().id });
    expect(await t.count()).toBe(1);

    // A second confirmation is an outcome without an event and without a second count.
    expect(await t.confirm(r.submissionId)).toMatchObject({ status: 'already_confirmed' });
    expect(await t.drain()).toEqual([]);
    expect(await t.count()).toBe(1);
  });

  it('mails a participation confirmation without consent, and the signature grants no list', async () => {
    const t = await setup();
    await t.publish();
    await t.open();
    const r = await t.sign('bea@example.org', false);
    if (r.status !== 'accepted') throw new Error(r.status);
    expect(t.uow.store.outbox.map((e) => e.type)).toEqual([PARTICIPATION_REQUESTED]);
    expect(t.uow.store.outbox[0]?.props).toMatchObject({
      campaignId: t.campaign().id,
      confirmed: false,
    });
    await t.drain();
    await t.confirm(r.submissionId);
    await t.drain();
    expect(await t.count()).toBe(1);
    const supporter = await t.supporterOf('bea@example.org');
    expect(supporter?.lists).toEqual([]);
    expect(supporter?.pendingLists).toEqual([]);
  });

  it('with consent, one confirmation counts the signature and confirms the list', async () => {
    const t = await setup();
    await t.publish();
    await t.open();
    const r = await t.sign('cor@example.org', true);
    if (r.status !== 'accepted') throw new Error(r.status);
    // The consent confirmation carries the signature; no second link.
    expect(t.uow.store.outbox.map((e) => e.type)).toEqual(['newsletter.subscribed']);
    await t.drain();
    await t.confirm(r.submissionId);
    expect((await t.drain()).map((e) => e.type)).toEqual(['petition.signed', 'consent.given']);
    expect(await t.count()).toBe(1);
    expect((await t.supporterOf('cor@example.org'))?.lists).toEqual([t.form.list]);
  });

  it('counts a repost by the same address once', async () => {
    const t = await setup();
    await t.publish();
    await t.open();
    await t.signAndConfirm('dirk@example.org');
    // Within a day the recipient limit refuses; after it a new submission and confirmation.
    expect(await t.sign('dirk@example.org')).toMatchObject({ reason: 'recipient-limited' });
    t.clock.advance(25 * HOUR);
    await t.signAndConfirm('dirk@example.org');
    expect(await t.count()).toBe(1);
  });

  it('withdraws a signature, and signing again restores it', async () => {
    const t = await setup();
    await t.publish();
    await t.open();
    await t.signAndConfirm('eva@example.org');
    await t.signAndConfirm('fem@example.org');
    expect(await t.count()).toBe(2);
    const eva = (await t.supporterOf('eva@example.org'))!;
    const withdraw = () =>
      t.invoker.run(useCases.withdrawParticipation, t.admin, {
        campaignId: t.campaign().id,
        supporterId: eva.id,
      });
    expect(await withdraw()).toMatchObject({ withdrawn: true, campaign: { participants: 1 } });
    expect(await withdraw()).toMatchObject({ withdrawn: false, campaign: { participants: 1 } });
    // Withdrawing needs the supporter capability, not content rights.
    await expectCode(
      t.invoker.run(
        useCases.withdrawParticipation,
        principal({ capabilities: ['content:read', 'content:write', 'content:publish'] }),
        { campaignId: t.campaign().id, supporterId: eva.id }
      ),
      'forbidden'
    );
    t.clock.advance(25 * HOUR);
    const again = await t.signAndConfirm('eva@example.org');
    expect(await t.count()).toBe(2);
    const row = await t.uow.run(systemPrincipal(TENANT, 'test'), (ctx) =>
      ctx.campaigns.participation(t.campaign().id, eva.id)
    );
    expect(row).toMatchObject({ submissionId: again, withdrawnAt: null });
  });

  it('refuses with campaign.closed when closed, before opening, outside the window or unpublished', async () => {
    const t = await setup();
    // Open but the landing page is not published: nothing to sign on.
    await t.open();
    await expectCode(t.sign('gijs@example.org'), 'conflict', 'campaign.closed');
    await t.publish();
    expect(await t.sign('gijs@example.org')).toMatchObject({ status: 'accepted' });
    // Published in nl only: an en submission is refused.
    await expectCode(t.sign('hans@example.org', false, 'en'), 'conflict', 'campaign.closed');
    // A stale open page posts after closing.
    await t.close();
    await expectCode(t.sign('ida@example.org'), 'conflict', 'campaign.closed');
    // A refusal writes nothing.
    expect(t.uow.store.outbox.filter((e) => e.props['email'] === 'ida@example.org')).toEqual([]);
  });

  it('refuses after the window has passed, evaluated at the moment of the submission', async () => {
    const t = await setup();
    await t.publish();
    const closesAt = new Date(t.clock.now().getTime() + HOUR).toISOString();
    const c = await t.invoker.run(useCases.updateCampaign, t.admin, {
      campaignId: t.campaign().id,
      baseUpdatedAt: t.campaign().updatedAt,
      window: { opensAt: null, closesAt },
    });
    await t.invoker.run(useCases.openCampaign, t.admin, {
      campaignId: c.id,
      baseUpdatedAt: c.updatedAt,
    });
    expect(await t.sign('jan@example.org')).toMatchObject({ status: 'accepted' });
    t.clock.advance(HOUR);
    await expectCode(t.sign('kim@example.org'), 'conflict', 'campaign.closed');
  });

  it('counts a signature submitted while open and confirmed after closing', async () => {
    const t = await setup();
    await t.publish();
    await t.open();
    const r = await t.sign('lex@example.org');
    if (r.status !== 'accepted') throw new Error(r.status);
    await t.drain();
    await t.close();
    await t.confirm(r.submissionId);
    await t.drain();
    expect(await t.count()).toBe(1);
  });

  it('keeps the count through an erasure, and recounting from the rows gives the same number', async () => {
    const t = await setup();
    await t.publish();
    await t.open();
    await t.signAndConfirm('mia@example.org');
    await t.signAndConfirm('nol@example.org');
    await t.signAndConfirm('olaf@example.org');
    const olaf = (await t.supporterOf('olaf@example.org'))!;
    await t.invoker.run(useCases.withdrawParticipation, t.admin, {
      campaignId: t.campaign().id,
      supporterId: olaf.id,
    });
    expect(await t.count()).toBe(2);
    const mia = (await t.supporterOf('mia@example.org'))!;
    await t.invoker.run(useCases.eraseSupporter, t.admin, { supporterId: mia.id });
    await t.uow.run(systemPrincipal(TENANT, 'test'), (ctx) => ctx.erasures.apply());
    // The erased signature left its row and joined the anonymous count; the total stays.
    const s = t.uow.store.for(TENANT);
    expect([...s.participations.values()].some((p) => p.supporterId === mia.id)).toBe(false);
    expect(s.campaigns.get(t.campaign().id)?.erasedCount).toBe(1);
    expect(await t.count()).toBe(2);
    // Recount from what is left: active rows plus the anonymous count.
    const active = [...s.participations.values()].filter(
      (p) => p.campaignId === t.campaign().id && !p.withdrawnAt
    ).length;
    expect(active + s.campaigns.get(t.campaign().id)!.erasedCount).toBe(2);
    // A second apply finds nothing more to move.
    await t.uow.run(systemPrincipal(TENANT, 'test'), (ctx) => ctx.erasures.apply());
    expect(await t.count()).toBe(2);
  });

  it('a signup campaign records form.submitted, and a form without a campaign is unchanged', async () => {
    const t = await setup('signup');
    await t.publish();
    await t.open();
    const r = await t.sign('piet@example.org', true);
    if (r.status !== 'accepted') throw new Error(r.status);
    await t.drain();
    await t.confirm(r.submissionId);
    expect((await t.drain()).map((e) => e.type)).toEqual(['form.submitted', 'consent.given']);
    expect(await t.count()).toBe(1);

    const loose = await t.invoker.run(useCases.createForm, t.admin, { kind: 'petition' });
    const plain = await t.invoker.run(useCases.submitForm, t.admin, {
      formId: loose.id,
      values: { email: 'quinn@example.org', consent: false },
      locale: 'nl',
    });
    expect(plain.status).toBe('accepted');
    expect(t.uow.store.outbox).toEqual([]);
  });
});
