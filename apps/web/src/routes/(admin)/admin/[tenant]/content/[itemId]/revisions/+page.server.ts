// The revisions of one item (TODO #11, brief content-editor § A1): who saved each and when, a
// preview per revision, and a comparison of two revisions as a diff (ADR 009 rule 9). The
// comparison is a GET form, so a diff has its own URL and works without JavaScript.
import { pickAny, isUuid, UseCaseError, useCases } from '@mycel/core';
import { actorLabel, diffRows, when } from '#lib/server/content-admin.js';
import { adminTimeZone } from '#lib/server/admin/admin.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';
import { refuse } from '#lib/server/http/refuse.js';

export const load: PageServerLoad = async ({ parent, locals, params, url }) => {
  await parent();
  const principal = locals.principal!;
  const { zone } = await adminTimeZone(locals);
  const { invoker } = runtime();
  if (!isUuid(params.itemId)) refuse(404);
  const after = url.searchParams.get('after');
  try {
    const { item } = await invoker.run(useCases.getItem, principal, { itemId: params.itemId });
    const { revisions, next } = await invoker.run(useCases.listRevisions, principal, {
      itemId: item.id,
      ...(after && isUuid(after) ? { after } : {}),
    });
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    const diff =
      isUuid(from) && isUuid(to)
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
      contentType: item.type,
      item: {
        id: item.id,
        title: pickAny(item.title, item.defaultLocale) ?? '',
        locales: item.locales,
        defaultLocale: item.defaultLocale,
        latest: item.latestRevisionId,
      },
      revisions: revisions.map((r) => ({
        id: r.id,
        when: when(r.createdAt, zone),
        who: actorLabel(r.actor),
      })),
      next,
      compare: { from, to },
      diff,
    };
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') refuse(404);
    throw e;
  }
};
