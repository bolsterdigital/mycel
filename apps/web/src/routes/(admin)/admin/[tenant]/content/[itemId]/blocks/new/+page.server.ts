// Insert a block (brief content-editor § B): the edit page's GET form chose a type and a place
// next to a block (or at the start or end) on the revision it showed; this page shows the new
// block's fields, empty, and its POST runs `content.item.insert` with that revision as
// `baseRevisionId`. Core validates the new block like any save, so a refusal comes back with
// what was typed. A page of its own instead of a field set per type on the edit page, because a
// block that is not valid yet cannot be inserted first and filled in later (ADR 004: no invalid
// props are stored).
import { error, fail, redirect } from '@sveltejs/kit';
import {
  BLOCK_DEFINITIONS,
  BLOCK_TYPES,
  UseCaseError,
  useCases,
  type BlockInput,
  type BlockType,
  type Principal,
} from '@mycel/core';
import { formValues, posted, propsFromForm } from '#lib/editor/block-form.js';
import { failureOf, text } from '#lib/server/admin-actions.js';
import { requireTenantPrincipal } from '#lib/server/admin.js';
import { actorLabel, when } from '#lib/server/content-admin.js';
import { fieldIssues, issueCopy, pickerOptions } from '#lib/server/content-blocks.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLACES = ['before', 'after', 'start', 'end'] as const;
type Place = (typeof PLACES)[number];

/** The request of the GET form (or the hidden fields of the POST), or a 404 when it is not one. */
function request(get: (name: string) => string | null) {
  const type = get('type') ?? '';
  const place = (get('place') ?? '') as Place;
  const anchor = get('anchor') ?? '';
  const revision = get('revision') ?? '';
  if (!(BLOCK_TYPES as string[]).includes(type) || !PLACES.includes(place) || !UUID.test(revision))
    error(404, 'Not found');
  if ((place === 'before' || place === 'after') !== (anchor !== '')) error(404, 'Not found');
  return { type: type as BlockType, place, anchor, revision };
}

/** The item at the revision the edit page showed, or a 404. */
async function itemAt(principal: Principal, itemId: string, revisionId: string) {
  if (!UUID.test(itemId)) error(404, 'Not found');
  try {
    return await runtime().invoker.run(useCases.getItem, principal, { itemId, revisionId });
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') error(404, 'Not found');
    throw e;
  }
}

export const load: PageServerLoad = async ({ parent, locals, params, url }) => {
  await parent();
  const principal = locals.principal!;
  const req = request((n) => url.searchParams.get(n));
  const { item, revision } = await itemAt(principal, params.itemId, req.revision);
  const doc = revision.document;
  const index = doc.blocks.findIndex((b) => b.id === req.anchor);
  if (req.anchor && index < 0) error(404, 'Not found');
  return {
    request: req,
    position: index + 1,
    item: {
      id: item.id,
      title: item.title[item.defaultLocale] ?? Object.values(item.title)[0] ?? '',
    },
    values: formValues(BLOCK_DEFINITIONS[req.type].fields, undefined, doc.locales),
    docLocales: doc.locales,
    ...(await pickerOptions(principal, [], item.defaultLocale)),
  };
};

export const actions: Actions = {
  default: async ({ locals, url, params, request: http }) => {
    const { tenant, principal } = await requireTenantPrincipal(locals, url, params.tenant);
    const data = await http.formData();
    const req = request((n) => text(data, n) || null);
    const values: Record<string, string> = {};
    for (const [k, v] of data) if (typeof v === 'string') values[k] ??= v;
    const fields = BLOCK_DEFINITIONS[req.type].fields;
    const { props, errors } = propsFromForm(fields, posted(data));
    if (errors.length)
      return fail(400, {
        error: 'admin.block.error.invalid' as UiKey,
        values,
        fieldIssues: errors.map((e) => ({ name: e.name, copy: issueCopy(e.message) })),
        conflict: null,
      });
    const { revision } = await itemAt(principal, params.itemId, req.revision);
    const blocks = revision.document.blocks;
    const at = blocks.findIndex((b) => b.id === req.anchor);
    const index =
      req.place === 'start'
        ? 0
        : req.place === 'end'
          ? blocks.length
          : at + (req.place === 'after' ? 1 : 0);
    let created: string;
    try {
      const result = await runtime().invoker.run(useCases.insertBlock, principal, {
        itemId: params.itemId,
        baseRevisionId: req.revision,
        block: {
          type: req.type,
          version: BLOCK_DEFINITIONS[req.type].version,
          props,
        } as BlockInput,
        place:
          req.place === 'before'
            ? { before: req.anchor }
            : req.place === 'after'
              ? { after: req.anchor }
              : { at: req.place },
      });
      created = result.created[0]!;
    } catch (e) {
      if (!(e instanceof UseCaseError)) throw e;
      const { status, body } = failureOf(e, 'insert', {
        conflict: 'admin.content.conflict.title',
        invalid: 'admin.block.error.invalid',
      });
      // A conflict carries the newest revision, so sending the form again is a deliberate choice
      // to insert into it (as the document form of A1 does).
      let conflict = null;
      if (e.code === 'conflict') {
        const { revision: newest } = await runtime().invoker.run(useCases.getItem, principal, {
          itemId: params.itemId,
        });
        conflict = { who: actorLabel(newest.actor), when: when(newest.createdAt) };
        values['revision'] = newest.id;
      }
      return fail(status, {
        ...body,
        values,
        fieldIssues: e.code === 'invalid_input' ? fieldIssues(e, index) : [],
        conflict,
      });
    }
    redirect(
      303,
      `/admin/${tenant.slug}/content/${params.itemId}?done=blockInserted&block=${encodeURIComponent(created)}#block-${created}`
    );
  },
};
