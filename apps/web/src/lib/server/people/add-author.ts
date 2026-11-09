// Adding a person keeps the posted article intact, like a row arrangement. Only the person is
// stored; the selection is saved with the article. Rejected: saving a half-written article first.
import { can, slugFromTitle, useCases } from '@mycel/core';
import type { RequestEvent, ActionFailure } from '@sveltejs/kit';
import { requireTenantPrincipal } from '../admin/admin.js';
import { text, failureOf } from '../admin/admin-actions.js';
import { refuse, refusalOf } from '../http/refuse.js';
import { runtime } from '../runtime.js';
import { valuesFromForm, type FormValues } from '../content/content-admin.js';
import { NEW_BLOCK, pendingBlock, type PendingBlock } from '../content/edit-form.js';
import type { ArrangeDeps } from '../content/arrange.js';
import type { UiKey } from '../../../i18n/index.js';

type Principal = Awaited<ReturnType<typeof requireTenantPrincipal>>['principal'];
type Tenant = Awaited<ReturnType<typeof requireTenantPrincipal>>['tenant'];
interface Deps<R> {
  latest: ArrangeDeps<R>['latest'];
  show(
    tenant: Tenant,
    principal: Principal,
    itemId: string,
    values: FormValues,
    pending: PendingBlock | null,
    outcome: { error: UiKey; status?: number; recovered?: boolean }
  ): Promise<ActionFailure<R>>;
}
export async function addAuthor<R>(event: RequestEvent, deps: Deps<R>) {
  const { tenant, principal } = await requireTenantPrincipal(
    event.locals,
    event.url,
    event.params['tenant']!
  );
  if (!can(principal, 'content:write')) refuse(403);
  const itemId = event.params['itemId']!;
  const { document } = (await deps.latest(principal, itemId)).revision;
  if (document.type !== 'article') refuse(400);
  const data = await event.request.formData();
  const values = valuesFromForm(data);
  const pending = pendingBlock(
    text(data, `${NEW_BLOCK}type`),
    text(data, `${NEW_BLOCK}place`),
    text(data, `${NEW_BLOCK}anchor`),
    document.blocks.map((b) => b.id)
  );
  try {
    const name = text(data, 'newAuthorName').trim();
    const person = await runtime().invoker.run(useCases.createPerson, principal, {
      name,
      slug: text(data, 'newAuthorSlug').trim() || slugFromTitle(name),
    });
    values.authorIds = [...(Array.isArray(values.authorIds) ? values.authorIds : []), person.id];
    values.newAuthorName = '';
    values.newAuthorSlug = '';
  } catch (e) {
    const { status, body } = failureOf(refusalOf(e), 'addAuthor', {
      conflict: 'admin.people.conflict',
    });
    return deps.show(tenant, principal, itemId, values, pending, { error: body.error, status });
  }
  return (
    await deps.show(tenant, principal, itemId, values, pending, {
      error: 'admin.people.added',
      recovered: true,
    })
  ).data;
}
