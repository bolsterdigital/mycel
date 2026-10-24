// The revisions of one item (TODO #11, brief content-editor § A1): who saved each and when, a
// preview per revision, and a comparison of two revisions as a diff (ADR 009 rule 9). The
// comparison is a GET form, so a diff has its own URL and works without JavaScript.
import { error } from '@sveltejs/kit';
import { UseCaseError, useCases } from '@mycel/core';
import { actorLabel, diffRows, when } from '#lib/server/content-admin.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const load: PageServerLoad = async ({ parent, locals, params, url }) => {
  await parent();
  const principal = locals.principal!;
  const { invoker } = runtime();
  if (!UUID.test(params.itemId)) error(404, 'Not found');
  const after = url.searchParams.get('after');
  try {
    const { item } = await invoker.run(useCases.getItem, principal, { itemId: params.itemId });
    const { revisions, next } = await invoker.run(useCases.listRevisions, principal, {
      itemId: item.id,
      ...(after && UUID.test(after) ? { after } : {}),
    });
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    const diff =
      UUID.test(from) && UUID.test(to)
        ? diffRows(
            (
              await invoker.run(useCases.diffRevisions, principal, {
                itemId: item.id,
                fromRevisionId: from,
                toRevisionId: to,
              })
            ).changes
          )
        : null;
    return {
      item: {
        id: item.id,
        title: item.title[item.defaultLocale] ?? Object.values(item.title)[0] ?? '',
        locales: item.locales,
        defaultLocale: item.defaultLocale,
        latest: item.latestRevisionId,
      },
      revisions: revisions.map((r) => ({
        id: r.id,
        when: when(r.createdAt),
        who: actorLabel(r.actor),
      })),
      next,
      compare: { from, to },
      diff,
    };
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') error(404, 'Not found');
    throw e;
  }
};
