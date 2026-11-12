// Where the campaign panel of a landing page posts (lib/server/admin/campaigns.ts): save,
// open and close, each one use case on the `baseUpdatedAt` the panel was rendered with, so a tab
// left open refuses instead of undoing a newer change (ADR 027). Every answer is a 303 back to the
// landing page's editor with the outcome; a GET of this address goes there too, since a campaign
// has no screen of its own beside its page (ADR 033 rule 1).
import { redirect } from '@sveltejs/kit';
import { can, useCases, UseCaseError, type Principal } from '@mycel/core';
import { requireTenantPrincipal, adminTimeZone } from '#lib/server/admin/admin.js';
import { loaded, text } from '#lib/server/admin/admin-actions.js';
import {
  campaignFields,
  refusalOutcome,
  type CampaignOutcome,
} from '#lib/server/admin/campaigns.js';
import { refusalOf } from '#lib/server/http/refuse.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

const run = () => runtime().invoker;

export const load: PageServerLoad = async ({ parent, locals, params }) => {
  await parent();
  const campaign = await loaded(
    run().run(useCases.getCampaign, locals.principal!, { campaignId: params.id })
  );
  redirect(303, `/admin/${params.tenant}/content/${campaign.landingItemId}#campaign`);
};

type Event = Parameters<Actions[string]>[0];

/**
 * Run one campaign use case and go back to the landing page's editor with its outcome. The
 * landing page comes from the stored campaign, never from the post.
 */
async function answer(
  event: Event,
  done: CampaignOutcome,
  fn: (principal: Principal, data: FormData, base: string) => Promise<unknown>
): Promise<never> {
  const { principal } = await requireTenantPrincipal(event.locals, event.url, event.params.tenant);
  const data = await event.request.formData();
  const campaign = await loaded(
    run().run(useCases.getCampaign, principal, { campaignId: event.params.id })
  );
  let outcome: CampaignOutcome = done;
  try {
    await fn(principal, data, text(data, 'baseUpdatedAt'));
  } catch (e) {
    outcome = refusalOutcome(refusalOf(e));
  }
  redirect(
    303,
    `/admin/${event.params.tenant}/content/${campaign.landingItemId}?campaign=${outcome}#campaign`
  );
}

export const actions: Actions = {
  update: (event) =>
    answer(event, 'saved', async (principal, data, baseUpdatedAt) => {
      const { zone } = await adminTimeZone(event.locals);
      const fields = campaignFields(data, zone, can(principal, 'content:publish'));
      if (!fields) throw new UseCaseError('invalid_input', 'not a time or a whole number');
      // Milestones have no field yet: keep the stored ones that stay below the new target.
      const current = await run().run(useCases.getCampaign, principal, {
        campaignId: event.params.id,
      });
      const goal = fields.goal && {
        target: fields.goal.target,
        milestones: (current.goal?.milestones ?? []).filter((m) => m < fields.goal!.target),
      };
      await run().run(useCases.updateCampaign, principal, {
        campaignId: event.params.id,
        baseUpdatedAt,
        ...fields,
        goal,
      });
    }),
  open: (event) =>
    answer(event, 'opened', (principal, _data, baseUpdatedAt) =>
      run().run(useCases.openCampaign, principal, { campaignId: event.params.id, baseUpdatedAt })
    ),
  close: (event) =>
    answer(event, 'closed', (principal, _data, baseUpdatedAt) =>
      run().run(useCases.closeCampaign, principal, { campaignId: event.params.id, baseUpdatedAt })
    ),
};
