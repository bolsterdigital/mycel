// How a site grew lately (`activity.ts`) over the memory adapter: the window on the site's
// calendar across a summer-time change, who counts as joined and left, campaign participations
// and the rights. That Postgres reads the same changes is the adapter-rules scenario
// (`packages/db/src/supporters/list-rule.ts`), with an erased supporter and another tenant.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal, type Principal } from '../principal.js';
import { MemoryUnitOfWork, TENANT, expectCode } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { activityWindow } from './activity.js';
import { SupporterEvent } from './events.js';
import { ingest } from './service.js';

const admin = systemPrincipal(TENANT, 'test');
const as = (...capabilities: Principal['capabilities']): Principal => ({ ...admin, capabilities });
const UNTIL = '2026-11-19T10:00:00.000Z';

describe('activityWindow', () => {
  it('spans thirty local days, today included, and starts each at local midnight', () => {
    const w = activityWindow(new Date(UNTIL), 'Europe/Amsterdam');
    expect(w.dates).toHaveLength(30);
    expect([w.dates[0], w.dates.at(-1)]).toEqual(['2026-10-21', '2026-11-19']);
    // 21 October is still summer time (UTC+2); the window before starts in September.
    expect(w.from.toISOString()).toBe('2026-10-20T22:00:00.000Z');
    expect(w.previousFrom.toISOString()).toBe('2026-09-20T22:00:00.000Z');
    expect(activityWindow(new Date(UNTIL), 'UTC').from.toISOString()).toBe(
      '2026-10-21T00:00:00.000Z'
    );
  });
});

describe('supporter.activity.get', () => {
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let campaignId: string;
  let n = 0;

  const add = (email: string, at: string, type: SupporterEvent['type'], props = {}) => {
    // A campaign participation is a submission of this platform (ADR 033 rule 7).
    const id = `01930000-0000-7000-8000-0000000001${(n++).toString(16).padStart(2, '0')}`;
    const ref = type === 'petition.signed' ? `submission:${id}` : `activity-${id}`;
    return uow.run(admin, (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: `activity-${id}`,
          type,
          email,
          occurred_at: at,
          source: type === 'petition.signed' ? 'mycel' : 'test',
          source_site: 'urn:mycel:test',
          source_ref: ref,
          props,
        })
      )
    );
  };
  const summary = (by = admin) => invoker.run(useCases.getSupporterActivity, by, { until: UNTIL });

  beforeEach(async () => {
    uow = new MemoryUnitOfWork();
    invoker = new Invoker(buildRegistry(), uow);
    const { item } = await invoker.run(useCases.createItem, admin, {
      slug: 'teken',
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Teken de petitie' },
        blocks: [],
      } as never,
    });
    campaignId = (
      await invoker.run(useCases.createCampaign, admin, {
        kind: 'petition',
        landingItemId: item.id,
      })
    ).id;
    const news = { list: 'news' };
    // Twice in the window, one person: one join, on the first day.
    await add('anna@example.org', '2026-11-18T08:00:00Z', 'newsletter.subscribed', news);
    await add('anna@example.org', '2026-11-19T08:00:00Z', 'newsletter.subscribed', news);
    // Not confirmed yet: no join.
    await add('bram@example.org', '2026-11-18T08:00:00Z', 'newsletter.subscribed', {
      list: 'news',
      confirmed: false,
    });
    // Confirmed through the double opt-in link, late in the evening: 19 November in Amsterdam.
    await add('cato@example.org', '2026-11-18T23:30:00Z', 'consent.given', news);
    // In the thirty days before; and before both windows.
    await add('dirk@example.org', '2026-10-01T08:00:00Z', 'newsletter.subscribed', news);
    await add('oud@example.org', '2026-08-01T08:00:00Z', 'newsletter.subscribed', news);
    // In and out again: a join and a leave.
    await add('eva@example.org', '2026-11-01T08:00:00Z', 'newsletter.subscribed', news);
    await add('eva@example.org', '2026-11-02T08:00:00Z', 'newsletter.unsubscribed', news);
    await add('eva@example.org', '2026-11-03T08:00:00Z', 'petition.signed', {
      campaign_id: campaignId,
    });
    await add('finn@example.org', '2026-11-19T07:00:00Z', 'petition.signed', {
      campaign_id: campaignId,
    });
    // After `until`: not yet.
    await add('gijs@example.org', '2026-11-19T11:00:00Z', 'newsletter.subscribed', news);
  });

  it('counts joins and leaves per list and participations per campaign, per day', async () => {
    const s = await summary();
    expect(s).toMatchObject({
      from: '2026-10-20T22:00:00.000Z',
      until: UNTIL,
      timeZone: 'Europe/Amsterdam',
      joined: 3,
      joinedBefore: 1,
      left: 1,
      participations: 2,
      participationsBefore: 0,
    });
    expect(s.lists).toEqual([{ list: 'news', joined: 3, joinedBefore: 1, left: 1, members: 5 }]);
    expect(s.campaigns).toEqual([
      {
        id: campaignId,
        kind: 'petition',
        title: { nl: 'Teken de petitie' },
        participations: 2,
        participationsBefore: 0,
      },
    ]);
    expect(s.days).toHaveLength(30);
    expect(s.days.filter((d) => d.joined || d.participations)).toEqual([
      { date: '2026-11-01', joined: 1, participations: 0 },
      { date: '2026-11-03', joined: 0, participations: 1 },
      { date: '2026-11-18', joined: 1, participations: 0 },
      { date: '2026-11-19', joined: 1, participations: 1 },
    ]);
  });

  it('asks supporters:read and names a campaign only for a reader of content', async () => {
    await expectCode(summary(as('content:read')), 'forbidden');
    const s = await summary(as('supporters:read'));
    expect(s.campaigns[0]?.title).toBeNull();
    expect(s.joined).toBe(3);
  });

  it('refuses a zone the runtime does not know', async () => {
    await expectCode(
      invoker.run(useCases.getSupporterActivity, admin, { timeZone: '+01:00' }),
      'invalid_input'
    );
  });
});
