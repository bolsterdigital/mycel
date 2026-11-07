// A durable run is a bookmarkable report. GET never advances work; every confirmed POST
// executes one registry ordinal, so a lost response can safely resume from the stored report.
import { redirect } from '@sveltejs/kit';
import { can, ContentType, pickAny, useCases } from '@mycel/core';
import { act, loaded, orNull } from '#lib/server/admin/admin-actions.js';
import { listPath, listViewFrom } from '#lib/server/content/content-list.js';
import { nextBulkSlot } from '#lib/server/content/content-bulk.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, params, locals, url }) => {
  await parent();
  const { invoker } = runtime();
  const principal = locals.principal!;
  const plan = await loaded(invoker.run(useCases.getBulk, principal, { planId: params.run }));
  const report = await loaded(invoker.run(useCases.checkBulk, principal, { planId: params.run }));
  const sectionIds = [
    ...new Set(
      plan.items.flatMap((slot) => {
        const doc = slot.preview.candidate;
        return doc?.type === 'article' && doc.sectionId ? [doc.sectionId] : [];
      })
    ),
  ];
  const sections = Object.fromEntries(
    await Promise.all(
      sectionIds.map(async (sectionId) => {
        const section = await orNull(invoker.run(useCases.getSection, principal, { sectionId }));
        return [
          sectionId,
          section ? (pickAny(section.title, plan.locale) ?? section.slug) : sectionId,
        ];
      })
    )
  );
  const type = ContentType.safeParse(url.searchParams.get('type')).data ?? 'page';
  return {
    sections,
    step: `${url.pathname}?${url.searchParams}&/step`,
    back: listPath(params.tenant, type, listViewFrom(url.searchParams, type)),
    plan,
    report,
    canAct: can(principal, 'content:publish') || can(principal, 'content:write'),
    next: nextBulkSlot(report.items, report.undoRequested ? 'undo' : 'apply'),
  };
};

export const actions: Actions = {
  step: async (event) => {
    const result = await act(
      event,
      'step',
      {
        conflict: 'admin.content.bulk.changed',
        invalid: 'admin.content.bulk.invalid',
      },
      async (principal, form) => {
        const { invoker } = runtime();
        const input = {
          planId: event.params.run,
          version: Number(form.get('version')) as 1,
          ordinal: Number(form.get('ordinal')),
        };
        return invoker.run(
          form.get('phase') === 'undo' ? useCases.withdrawBulk : useCases.resumeBulk,
          principal,
          input
        );
      }
    );
    if ('status' in result) return result;
    const query = new URLSearchParams(
      [...event.url.searchParams].filter(([key]) => !key.startsWith('/'))
    );
    redirect(303, `${event.url.pathname}?${query}`);
  },
};
