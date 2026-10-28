// Remove a block (brief content-editor § B): a confirmation page of its own, so it works without
// JavaScript and nothing is removed by one stray click. It names the block and the revision the
// edit page showed; the POST runs `content.block.remove` with that revision as `baseRevisionId`,
// which also merges two text blocks that end up next to each other (ADR 020 rule 4). Rejected: a
// `confirm()` dialog (needs a script) and removing straight from the edit page.
import { error, fail, redirect } from '@sveltejs/kit';
import { UseCaseError, useCases, type Principal } from '@mycel/core';
import { failureOf, text } from '#lib/server/admin-actions.js';
import { requireTenantPrincipal } from '#lib/server/admin.js';
import { actorLabel, when } from '#lib/server/content-admin.js';
import { summaryOf } from '#lib/server/content-blocks.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The block at the revision, with its position, or a 404. */
async function blockAt(principal: Principal, itemId: string, revisionId: string, blockId: string) {
  if (!UUID.test(itemId) || !UUID.test(revisionId)) error(404, 'Not found');
  try {
    const { item, revision } = await runtime().invoker.run(useCases.getItem, principal, {
      itemId,
      revisionId,
    });
    const index = revision.document.blocks.findIndex((b) => b.id === blockId);
    if (index < 0) error(404, 'Not found');
    return { item, block: revision.document.blocks[index]!, index };
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') error(404, 'Not found');
    throw e;
  }
}

export const load: PageServerLoad = async ({ parent, locals, params, url }) => {
  await parent();
  const revision = url.searchParams.get('revision') ?? '';
  const { item, block, index } = await blockAt(
    locals.principal!,
    params.itemId,
    revision,
    params.blockId
  );
  return {
    item: {
      id: item.id,
      type: item.type,
      title: item.title[item.defaultLocale] ?? Object.values(item.title)[0] ?? '',
    },
    block: {
      id: block.id,
      type: block.type,
      position: index + 1,
      summary: summaryOf(block, item.defaultLocale),
    },
    revision,
  };
};

export const actions: Actions = {
  default: async ({ locals, url, params, request }) => {
    const { tenant, principal } = await requireTenantPrincipal(locals, url, params.tenant);
    const baseRevisionId = text(await request.formData(), 'revision');
    try {
      await runtime().invoker.run(useCases.removeBlock, principal, {
        itemId: params.itemId,
        baseRevisionId,
        blockId: params.blockId,
      });
    } catch (e) {
      if (!(e instanceof UseCaseError)) throw e;
      const { status, body } = failureOf(e, 'remove', {
        conflict: 'admin.block.remove.conflict',
        invalid: 'admin.block.error.invalid',
      });
      let conflict = null;
      if (e.code === 'conflict') {
        const { revision } = await runtime().invoker.run(useCases.getItem, principal, {
          itemId: params.itemId,
        });
        conflict = { who: actorLabel(revision.actor), when: when(revision.createdAt) };
      }
      return fail(status, { ...body, conflict });
    }
    redirect(303, `/admin/${tenant.slug}/content/${params.itemId}?done=blockRemoved#blocks`);
  },
};
