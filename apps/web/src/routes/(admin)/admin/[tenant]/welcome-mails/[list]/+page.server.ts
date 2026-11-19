// One list's welcome series (MY-258 PR 2): the form sets its steps and switch through
// `mailing.automation.update`, the test posts `mailing.automation.test`. Both use cases hold the
// authorization (`mailing:send`); this route only asks once more before a series is switched on,
// because from then on every new subscriber of the list gets mail: the first post that turns it
// on comes back with a confirmation naming the list, the second, with `confirmed`, saves.
// Rejected: a confirmation dialog (a script for a step that must work without one) and a
// checkbox "I understand" in the form (it would sit there on every save, also when nothing is
// switched on).
import { error, fail, redirect } from '@sveltejs/kit';
import { act, failureOf, loaded } from '#lib/server/admin/admin-actions.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { refusalOf } from '#lib/server/http/refuse.js';
import { runtime } from '#lib/server/runtime.js';
import { fields } from '#lib/server/people/form.js';
import { postedSteps, WELCOME_ISSUES, welcomeDetail } from '#lib/server/mail/welcome.js';
import { useCases } from '@mycel/core';
import type { Actions, PageServerLoad } from './$types';

const LIST = /^[a-z0-9][a-z0-9-]{0,62}$/;
const copy = { conflict: 'admin.welcome.refused.other', issues: WELCOME_ISSUES } as const;

export const load: PageServerLoad = async ({ parent, locals, params }) => {
  const { locale, tenant } = await parent();
  if (!LIST.test(params.list)) error(404);
  return {
    series: await loaded(
      welcomeDetail(locals.principal!, params.list, { ui: locale, site: tenant.defaultLocale })
    ),
  };
};

export const actions: Actions = {
  save: async ({ request, locals, url, params }) => {
    const { principal, tenant } = await requireTenantPrincipal(locals, url, params.tenant);
    const data = await request.formData();
    const values = fields(data);
    const steps = postedSteps(data);
    if (!steps.length)
      return fail(400, { action: 'save', error: 'admin.welcome.refused.noSteps' as const, values });
    const enabled = data.get('enabled') === 'on';
    try {
      const { automations } = await runtime().invoker.run(useCases.listAutomations, principal, {});
      const current = automations.find((a) => a.list === params.list);
      if (enabled && !current?.enabled && data.get('confirmed') !== '1')
        return { confirm: true, values };
      await runtime().invoker.run(useCases.updateAutomation, principal, {
        list: params.list,
        enabled,
        steps,
      });
    } catch (e) {
      const { status, body } = failureOf(refusalOf(e), 'save', copy);
      return fail(status, { ...body, values });
    }
    redirect(303, `/admin/${tenant.slug}/welcome-mails/${params.list}?saved=1`);
  },
  test: async (event) => {
    const result = await act(event, 'test', copy, (principal) =>
      runtime().invoker.run(useCases.testAutomation, principal, { list: event.params.list })
    );
    if ('steps' in result)
      redirect(
        303,
        `/admin/${event.params.tenant}/welcome-mails/${event.params.list}?tested=${result.steps}`
      );
    return result;
  },
};
