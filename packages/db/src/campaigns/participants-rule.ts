// The campaign participants scenario of the adapter rules (adapter-rules.test.ts runs it over the
// memory adapter and over Postgres and compares both with `expectedParticipants`). In a file of
// its own because the suite is at its size ceiling; it makes its own campaign and signers.

import {
  SupporterEvent,
  ingest,
  systemPrincipal,
  useCases,
  type Invoker,
  type UnitOfWork,
} from '@mycel/core';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 18, 9, minute)).toISOString();
const submission = (n: number) => `01930000-0000-7000-8000-0000000000${(0xb0 + n).toString(16)}`;

/**
 * `campaign.participation.list` and `.export`: everyone who took part in one campaign with their
 * address, newest confirmation first and the higher supporter id first within one moment, a
 * withdrawn participation still listed with its withdrawal and not counted as active. A page ends
 * with a cursor until the last one. An erased supporter is gone from the list and the totals, a
 * signer of another campaign is not listed, and another tenant does not find the campaign.
 */
export async function observeParticipants(
  invoker: Invoker,
  uow: UnitOfWork,
  erase: (tenantId: string) => Promise<unknown>,
  tenant: () => Promise<string>
) {
  const admin = systemPrincipal(await tenant(), 'adapter-rules');
  const other = systemPrincipal(await tenant(), 'adapter-rules');
  const campaignOn = async (slug: string) => {
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
    return invoker.run(useCases.createCampaign, admin, {
      kind: 'petition',
      landingItemId: item.id,
    });
  };
  const campaign = await campaignOn('teken-hier');
  const elsewhere = await campaignOn('teken-daar');
  let n = 0;
  const sign = (email: string, minute: number, campaignId = campaign.id) => {
    const ref = submission(n++);
    return uow.run(admin, (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: `participants-rule-${ref}`,
          type: 'petition.signed',
          email,
          occurred_at: at(minute),
          source: 'mycel',
          source_site: 'urn:mycel:test',
          source_ref: `submission:${ref}`,
          props: { campaign_id: campaignId },
        })
      )
    );
  };
  await sign('anna@example.org', 1);
  await sign('bram@example.org', 2);
  // One moment for two signers: the order falls to the supporter id.
  await sign('cato@example.org', 3);
  await sign('dirk@example.org', 3);
  await sign('gone@example.org', 4);
  await sign('eva@example.org', 5, elsewhere.id);

  const id = async (email: string) =>
    (await invoker.run(useCases.getSupporter, admin, { email })).id;
  await invoker.run(useCases.withdrawParticipation, admin, {
    campaignId: campaign.id,
    supporterId: await id('bram@example.org'),
  });
  const beforeErasure = (
    await invoker.run(useCases.listParticipations, admin, { campaignId: campaign.id })
  ).total;
  await uow.run(admin, async (ctx) =>
    ctx.erasures.register(await id('gone@example.org'), 'gone@example.org')
  );
  await erase(admin.tenantId);

  const list = (input: { after?: string; limit?: number } = {}, by = admin) =>
    invoker.run(useCases.listParticipations, by, { campaignId: campaign.id, limit: 50, ...input });
  const all = await list();
  const [first, second] = all.participants;
  const walked: string[] = [];
  let pages = 0;
  let after: string | undefined;
  do {
    const page = await list({ limit: 2, ...(after ? { after } : {}) });
    walked.push(...page.participants.map((p) => p.supporterId));
    after = page.next ?? undefined;
    pages += 1;
  } while (after && pages < 10);
  const file = await invoker.run(useCases.exportParticipations, admin, { campaignId: campaign.id });
  const lines = file.csv.split('\r\n');

  return {
    beforeErasure,
    // The two of one moment lead; which of them is first is `tieByIdDescending`.
    tied: [first?.email, second?.email].sort().join(' '),
    tieByIdDescending: Boolean(first && second && first.supporterId > second.supporterId),
    rest: all.participants
      .slice(2)
      .map((p) => `${p.email.split('@')[0]}${p.withdrawnAt ? ' (withdrawn)' : ''}`)
      .join(', '),
    confirmedAt: all.participants.at(-1)?.confirmedAt,
    total: all.total,
    active: all.active,
    next: all.next,
    walkedIsAll: walked.join(' ') === all.participants.map((p) => p.supporterId).join(' '),
    pages,
    header: lines[0],
    fileIsList:
      lines
        .slice(1, -1)
        .map((l) => l.split(',')[0])
        .join(' ') === all.participants.map((p) => p.email).join(' '),
    withdrawnCell: lines.slice(1, -1).map((l) => (l.split(',')[2] ? 'withdrawn' : 'counts')),
    file: { rows: file.rows, total: file.total, truncated: file.truncated },
    elsewhere: (
      await invoker.run(useCases.listParticipations, admin, { campaignId: elsewhere.id })
    ).participants.map((p) => p.email),
    otherTenant: await list({}, other).then(
      () => 'served',
      (e: { code: string }) => e.code
    ),
    malformedCursor: await list({ after: '1.not-a-uuid' }).then(
      () => 'served',
      (e: { code: string }) => e.code
    ),
  };
}

export const expectedParticipants = {
  beforeErasure: 5,
  tied: 'cato@example.org dirk@example.org',
  tieByIdDescending: true,
  rest: 'bram (withdrawn), anna',
  confirmedAt: at(1),
  total: 4,
  active: 3,
  next: null,
  walkedIsAll: true,
  pages: 2,
  header: 'email,confirmed_at,withdrawn_at,supporter_id',
  fileIsList: true,
  withdrawnCell: ['counts', 'counts', 'withdrawn', 'counts'],
  file: { rows: 4, total: 4, truncated: false },
  elsewhere: ['eva@example.org'],
  otherTenant: 'not_found',
  malformedCursor: 'invalid_input',
};
