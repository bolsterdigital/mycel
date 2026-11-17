// The supporter page scenario of the adapter rules (adapter-rules.test.ts runs it over the memory
// adapter and over Postgres and compares both with `expectedSupporterTimeline`). In a file of its
// own because the suite is at its size ceiling; it ingests its own supporter.

import {
  SupporterEvent,
  ingest,
  useCases,
  type Invoker,
  type Principal,
  type UnitOfWork,
} from '@mycel/core';

/** The fake clock of the suite: the scenario reads it and moves it on. */
interface Clock {
  now(): Date;
  advance(ms: number): void;
}

const page = {
  type: 'page' as const,
  defaultLocale: 'nl',
  locales: ['nl'],
  title: { nl: 'Teken de petitie' },
  blocks: [] as never[],
};

const MINUTE = 60_000;
/** A submission id for the participation row; nothing reads the submission itself. */
const SUBMISSION = '01930000-0000-7000-8000-0000000000a1';

/**
 * `supporter.timeline.get`: one live supporter of the tenant with their events newest first (the
 * later id first within one moment), each with its list, campaign or tier and nothing else of its
 * props; the campaigns they took part in with the withdrawal, and the landing title only for a
 * principal who reads content; the access they hold. An erased supporter, also one whose erasure
 * is registered and not yet applied, and a supporter of another tenant are not found.
 */
export async function observeSupporterTimeline(
  invoker: Invoker,
  uow: UnitOfWork,
  admin: Principal,
  other: Principal,
  clock: Clock,
  erase: (tenantId: string) => Promise<unknown>
) {
  const start = clock.now().getTime() - 60 * MINUTE;
  let n = 0;
  const add = (
    email: string,
    minute: number,
    type: SupporterEvent['type'],
    props: Record<string, unknown>,
    source: { source: string; ref?: string } = { source: 'test' },
    by = admin
  ) => {
    const id = `timeline-rule-${n++}`;
    return uow.run(by, (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id,
          type,
          email,
          occurred_at: new Date(start + minute * MINUTE).toISOString(),
          source: source.source,
          source_site: 'urn:mycel:test',
          source_ref: source.ref ?? id,
          props,
        })
      )
    );
  };

  const { item } = await invoker.run(useCases.createItem, admin, {
    slug: 'teken-de-petitie',
    document: page as never,
  });
  const campaign = await invoker.run(useCases.createCampaign, admin, {
    kind: 'petition',
    landingItemId: item.id,
  });
  const tier = await invoker.run(useCases.createAccessTier, admin, {
    slug: 'vrienden',
    name: { nl: 'Vrienden' },
  });

  await add('noor@example.org', 1, 'newsletter.subscribed', {
    list: 'news',
    confirmed: false,
    consent_text_version: 'v1',
  });
  await add('noor@example.org', 2, 'consent.given', { list: 'news' });
  // One moment, two events: the later id leads.
  await add('noor@example.org', 3, 'newsletter.subscribed', { list: 'campaign' });
  await add('noor@example.org', 3, 'newsletter.unsubscribed', { list: 'campaign' });
  await add(
    'noor@example.org',
    4,
    'petition.signed',
    { campaign_id: campaign.id, form_id: 'not-a-reference' },
    { source: 'mycel', ref: `submission:${SUBMISSION}` }
  );
  await add('gone@example.org', 5, 'newsletter.subscribed', { list: 'news' });
  await add('vreemd@example.org', 6, 'newsletter.subscribed', { list: 'news' }, undefined, other);

  const noor = await invoker.run(useCases.getSupporter, admin, { email: 'noor@example.org' });
  clock.advance(MINUTE);
  await invoker.run(useCases.createAccessGrant, admin, {
    supporterId: noor.id,
    tierId: tier.id,
    kind: 'comp',
    reason: 'Thanks for the help at the stall.',
  });
  clock.advance(MINUTE);
  await invoker.run(useCases.changeSupporterEmail, admin, {
    supporterId: noor.id,
    newEmail: 'noor@example.net',
    reason: 'Asked by phone.',
  });

  type Input = Parameters<typeof useCases.getSupporterTimeline.handler>[1];
  const get = (input: Partial<Input> = {}, by = admin) =>
    invoker.run(useCases.getSupporterTimeline, by, { supporterId: noor.id, limit: 100, ...input });
  const outcome = (supporterId: string, by = admin) =>
    get({ supporterId }, by).then(
      (t) => t.supporter.email,
      (e: { code: string }) => e.code
    );

  const full = await get();
  const signed = full.participations.map((p) => ({
    kind: p.kind,
    mine: p.campaignId === campaign.id,
    withdrawn: p.withdrawnAt !== null,
    title: p.landing?.title['nl'] ?? null,
  }));
  const readOnly = await get({}, { ...admin, capabilities: ['supporters:read'] });
  clock.advance(MINUTE);
  await invoker.run(useCases.withdrawParticipation, admin, {
    campaignId: campaign.id,
    supporterId: noor.id,
  });

  const gone = await invoker.run(useCases.getSupporter, admin, { email: 'gone@example.org' });
  const stranger = await invoker.run(useCases.getSupporter, other, {
    email: 'vreemd@example.org',
  });
  const beforeErasure = await outcome(gone.id);
  await uow.run(admin, (ctx) => ctx.erasures.register(gone.id, gone.email));
  const registered = await outcome(gone.id);
  await erase(admin.tenantId);

  return {
    email: full.supporter.email,
    lists: full.supporter.lists,
    pendingLists: full.supporter.pendingLists,
    types: full.events.map((e) => e.type),
    // What each entry carries beside id, type and moment.
    references: full.events.map((e) =>
      Object.keys(e)
        .filter((k) => !['id', 'type', 'occurredAt'].includes(k))
        .sort()
        .join(' ')
    ),
    pendingSignup: full.events.at(-1)?.confirmed,
    campaignOfSignature: full.events.find((e) => e.type === 'petition.signed')?.campaignId
      ? 'named'
      : 'missing',
    tieByIdDescending: Boolean(
      full.events[3] && full.events[4] && full.events[3].id > full.events[4].id
    ),
    newestFirst: full.events.every(
      (e, i, all) => i === 0 || Date.parse(all[i - 1]!.occurredAt) >= Date.parse(e.occurredAt)
    ),
    eventTotal: full.eventTotal,
    limited: await get({ limit: 2 }).then((t) => ({
      types: t.events.map((e) => e.type),
      eventTotal: t.eventTotal,
      participations: t.participations.length,
    })),
    signed,
    withdrawnAfter: (await get()).participations.map((p) => p.withdrawnAt !== null),
    titleWithoutContentRead: readOnly.participations.map((p) => p.landing),
    access: full.access.map((a) => ({
      name: a.name['nl'],
      grantKind: a.grantKind,
      standing: a.standing,
    })),
    beforeErasure,
    registered,
    erased: await outcome(gone.id),
    unknown: await outcome('01930000-0000-7000-8000-0000000000ff'),
    otherTenant: await outcome(stranger.id),
    ownTenant: await outcome(stranger.id, other),
  };
}

export const expectedSupporterTimeline = {
  email: 'noor@example.net',
  lists: ['news'],
  pendingLists: [],
  types: [
    'supporter.email_changed',
    'access.granted',
    'petition.signed',
    'newsletter.unsubscribed',
    'newsletter.subscribed',
    'consent.given',
    'newsletter.subscribed',
  ],
  references: ['', 'tierId', 'campaignId', 'list', 'confirmed list', 'list', 'confirmed list'],
  pendingSignup: false,
  campaignOfSignature: 'named',
  tieByIdDescending: true,
  newestFirst: true,
  eventTotal: 7,
  limited: {
    types: ['supporter.email_changed', 'access.granted'],
    eventTotal: 7,
    participations: 1,
  },
  signed: [{ kind: 'petition', mine: true, withdrawn: false, title: 'Teken de petitie' }],
  withdrawnAfter: [true],
  titleWithoutContentRead: [null],
  access: [{ name: 'Vrienden', grantKind: 'comp', standing: true }],
  beforeErasure: 'gone@example.org',
  registered: 'not_found',
  erased: 'not_found',
  unknown: 'not_found',
  otherTenant: 'not_found',
  ownTenant: 'vreemd@example.org',
};
