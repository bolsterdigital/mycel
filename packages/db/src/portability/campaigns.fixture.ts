// Seed a campaign with a form and one participation for the portable archive round trip (ADR 033
// rule 11). The participation row is written as the confirmation will write it. Rejected:
// a campaign without participation, which would leave that table empty and its import unproven.
import { sql, type Kysely } from 'kysely';
import { useCases, type Invoker, type Principal } from '@mycel/core';
import type { Database } from '../infra/schema.js';
import { asRole } from '../infra/roles.js';
import { uuidv7 } from '../infra/ids.js';

export async function seedCampaign(
  invoker: Invoker,
  operatorDb: Kysely<Database>,
  admin: Principal,
  email: string
) {
  const landing = await invoker.run(useCases.createItem, admin, {
    slug: 'petitie',
    document: {
      type: 'page',
      defaultLocale: 'nl',
      locales: ['nl'],
      title: { nl: 'Petitie' },
      blocks: [],
    },
  });
  const form = await invoker.run(useCases.createForm, admin, { kind: 'petition' });
  const campaign = await invoker.run(useCases.createCampaign, admin, {
    kind: 'petition',
    landingItemId: landing.item.id,
    formId: form.id,
    goal: { target: 1000, milestones: [10, 100] },
  });
  await asRole(operatorDb, 'mycel_app', async (trx) => {
    await sql`select set_config('app.tenant_id', ${admin.tenantId}, true)`.execute(trx);
    await sql`insert into campaign_participations
      (tenant_id, campaign_id, supporter_id, submission_id, confirmed_at)
      select ${admin.tenantId}, ${campaign.id}, id, ${uuidv7()}, now()
      from supporters where email = ${email}`.execute(trx);
  });
}
