// The `arrange` action of the edit screen: one entry of a row (a block's list shown as the site
// shows it, `BLOCK_PRESENTATION[type].row`) added, removed or moved in what the form posted, and
// the form shown again with nothing saved, as after a restored session (the same notice, with
// "Discard"). The new order and an
// empty new card are the writer's until Save, and without JavaScript this is how a row changes at
// all. Rejected: a save per step, which stores half-typed cards and refuses one whose title is not
// typed yet; and an action in the route module, which is at its size ceiling.

import { BLOCK_DEFINITIONS, can, type BlockType, type ContentDocument } from '@mycel/core';
import { error, type RequestEvent } from '@sveltejs/kit';
import { addButtonLists } from '#lib/admin/block-presentation.js';
import { LIST_MOVES, arrangeRows, type ListMove } from '#lib/editor/block-form.js';
import { text } from '#lib/server/admin/admin-actions.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { langOf, ui } from '../../../i18n/index.js';
import { valuesFromForm, type FormValues } from './content-admin.js';
import { NEW_BLOCK, pendingBlock, type PendingBlock } from './edit-form.js';

type Principal = Awaited<ReturnType<typeof requireTenantPrincipal>>['principal'];
type Tenant = Awaited<ReturnType<typeof requireTenantPrincipal>>['tenant'];

/**
 * The list a row button names, with its bounds: a row list of a block the document has
 * (`b.<id>.p.<key>`) or of the block being added (`new.p.<key>`). Anything else names nothing,
 * and the form comes back as it was posted.
 */
function rowList(document: ContentDocument, pendingType: string, name: string) {
  const match = /^(?:b\.([0-9a-f-]{36})|new)\.p\.([a-z][a-zA-Z]*)$/.exec(name);
  if (!match) return null;
  const [, blockId, key = ''] = match;
  const type = blockId ? document.blocks.find((b) => b.id === blockId)?.type : pendingType;
  if (!type || !(type in BLOCK_DEFINITIONS)) return null;
  if (!addButtonLists(type as BlockType).includes(key)) return null;
  const field = BLOCK_DEFINITIONS[type as BlockType].fields.find((f) => f.key === key);
  return field?.kind === 'list' ? { min: field.min, max: field.max } : null;
}

/** What the route gives: its latest revision and the way it shows a form again. */
export interface ArrangeDeps<R> {
  latest(
    principal: Principal,
    itemId: string
  ): Promise<{ revision: { document: ContentDocument } }>;
  show(
    tenant: Tenant,
    principal: Principal,
    itemId: string,
    values: FormValues,
    pending: PendingBlock | null,
    outcome: { error: 'admin.content.arranged'; recovered: true; arranged: string }
  ): Promise<{ data: R }>;
}

export async function arrange<R>(event: RequestEvent, deps: ArrangeDeps<R>): Promise<R> {
  const { tenant, principal } = await requireTenantPrincipal(
    event.locals,
    event.url,
    event.params['tenant']!
  );
  if (!can(principal, 'content:write'))
    error(403, ui(langOf(event.locals))('admin.error.forbidden'));
  const itemId = event.params['itemId']!;
  const { document } = (await deps.latest(principal, itemId)).revision;
  const data = await event.request.formData();
  const values = valuesFromForm(data);
  const [name = '', move = '', at = ''] = text(data, 'arrange').split('|');
  const bounds = rowList(document, text(data, `${NEW_BLOCK}type`), name);
  const arranged =
    bounds && (LIST_MOVES as readonly string[]).includes(move) && /^\d+$/.test(at)
      ? arrangeRows(values, name, move as ListMove, Number(at), bounds)
      : values;
  const pending = pendingBlock(
    text(data, `${NEW_BLOCK}type`),
    text(data, `${NEW_BLOCK}place`),
    text(data, `${NEW_BLOCK}anchor`),
    document.blocks.map((b) => b.id)
  );
  const outcome = {
    error: 'admin.content.arranged' as const,
    recovered: true as const,
    arranged: name,
  };
  return (await deps.show(tenant, principal, itemId, arranged, pending, outcome)).data;
}
