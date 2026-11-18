// Who took part in a campaign (`participants.ts`) over the memory adapter: the two rights, the
// file's shape and the fundraiser without rows. Order, paging, withdrawal, erasure and the tenant
// border are the adapter-rules scenario (`packages/db/src/campaigns/participants-rule.ts`), which
// holds memory and Postgres to one answer.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal, type Principal } from '../principal.js';
import { SupporterEvent } from '../supporters/events.js';
import { ingest } from '../supporters/service.js';
import { MemoryUnitOfWork, TENANT, expectCode } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';

const admin = systemPrincipal(TENANT, 'test');
const as = (...capabilities: Principal['capabilities']): Principal => ({ ...admin, capabilities });

describe('campaign participants', () => {
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let campaignId: string;
  let n = 0;

  const campaignOn = async (slug: string, kind: 'petition' | 'fundraiser') => {
    const { item } = await invoker.run(useCases.createItem, admin, {
      slug,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: slug },
        blocks: [],
      } as never,
    });
    return invoker.run(useCases.createCampaign, admin, { kind, landingItemId: item.id });
  };
  const sign = (email: string, minute: number) => {
    const ref = `01930000-0000-7000-8000-0000000000${(0xc0 + n++).toString(16)}`;
    return uow.run(admin, (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: `participants-${ref}`,
          type: 'petition.signed',
          email,
          occurred_at: new Date(Date.UTC(2026, 10, 18, 9, minute)).toISOString(),
          source: 'mycel',
          source_site: 'urn:mycel:test',
          source_ref: `submission:${ref}`,
          props: { campaign_id: campaignId },
        })
      )
    );
  };

  beforeEach(async () => {
    uow = new MemoryUnitOfWork();
    invoker = new Invoker(buildRegistry(), uow);
    campaignId = (await campaignOn('teken', 'petition')).id;
    await sign('anna@example.org', 1);
    // A visitor typed a formula as their address: the file keeps it as text.
    await sign('-2+3@example.org', 2);
  });

  it('lists the signers for a reader of supporters, not for a reader of content', async () => {
    const page = await invoker.run(useCases.listParticipations, as('supporters:read'), {
      campaignId,
    });
    expect(page).toMatchObject({ kind: 'petition', total: 2, active: 2, next: null });
    expect(page.participants.map((p) => p.email)).toEqual(['-2+3@example.org', 'anna@example.org']);
    expect(page.participants[1]).toMatchObject({
      confirmedAt: '2026-11-18T09:01:00.000Z',
      withdrawnAt: null,
    });
    await expectCode(
      invoker.run(useCases.listParticipations, as('content:read'), { campaignId }),
      'forbidden'
    );
  });

  it('exports them as CSV only with the export right', async () => {
    await expectCode(
      invoker.run(useCases.exportParticipations, as('supporters:read', 'content:read'), {
        campaignId,
      }),
      'forbidden'
    );
    const file = await invoker.run(useCases.exportParticipations, as('supporters:export'), {
      campaignId,
    });
    expect(file).toMatchObject({ rows: 2, total: 2, truncated: false });
    const lines = file.csv.split('\r\n');
    expect(lines[0]).toBe('email,confirmed_at,withdrawn_at,supporter_id');
    expect(lines[1]).toMatch(/^'-2\+3@example\.org,2026-11-18T09:02:00\.000Z,,[0-9a-f-]{36}$/);
    expect(lines.at(-1)).toBe('');
  });

  it('answers a fundraiser with no rows and an unknown campaign with not found', async () => {
    const fund = await campaignOn('geef', 'fundraiser');
    expect(
      await invoker.run(useCases.listParticipations, admin, { campaignId: fund.id })
    ).toMatchObject({ kind: 'fundraiser', participants: [], total: 0, active: 0 });
    expect(
      (await invoker.run(useCases.exportParticipations, admin, { campaignId: fund.id })).csv
    ).toBe('email,confirmed_at,withdrawn_at,supporter_id\r\n');
    const unknown = '01930000-0000-7000-8000-00000000ffff';
    await expectCode(
      invoker.run(useCases.listParticipations, admin, { campaignId: unknown }),
      'not_found'
    );
    await expectCode(
      invoker.run(useCases.exportParticipations, admin, { campaignId: unknown }),
      'not_found'
    );
  });
});
