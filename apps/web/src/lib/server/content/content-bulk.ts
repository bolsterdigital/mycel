// The list freezes explicit visible rows, never a query to execute later. Each POST advances
// one registry slot; rejected: a web execution loop that loses durable progress on disconnect.
import { useCases, UseCaseError, type Principal } from '@mycel/core';
import type { z } from 'zod';
import { runtime } from '../runtime.js';

export function selectedRows(
  form: FormData,
  visible: readonly { id: string; latestRevisionId: string }[]
) {
  const ids = form.has('all')
    ? form.getAll('visible').map(String)
    : form.getAll('selected').map(String);
  if (
    !ids.length ||
    ids.length > 100 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !visible.some((i) => i.id === id))
  )
    throw new UseCaseError('invalid_input', 'Invalid selection');
  return visible.filter((i) => ids.includes(i.id));
}

export async function prepareListBulk(
  principal: Principal,
  form: FormData,
  visible: readonly { id: string; latestRevisionId: string }[]
) {
  const selected = selectedRows(form, visible);
  const kind = String(form.get('operation'));
  if (!['publish', 'unpublish', 'section'].includes(kind))
    throw new UseCaseError('invalid_input', 'Invalid operation');
  const { invoker } = runtime();
  const items: z.infer<typeof useCases.createBulk.output>['items'][number]['selection'][] = [];
  for (const row of selected) {
    const baseRevisionId = String(form.get(`base-${row.id}`));
    if (kind === 'section') {
      const { revision } = await invoker.run(useCases.getItem, principal, {
        itemId: row.id,
        revisionId: baseRevisionId,
      });
      if (revision.document.type !== 'article')
        throw new UseCaseError('invalid_input', 'Articles only');
      items.push({
        itemId: row.id,
        baseRevisionId,
        operation: {
          kind: 'save',
          publish: false,
          document: { ...revision.document, sectionId: String(form.get('section')) || null },
        },
      });
    } else {
      items.push({
        itemId: row.id,
        baseRevisionId,
        operation:
          kind === 'publish' ? { kind, revisionId: baseRevisionId } : { kind: 'unpublish' },
      });
    }
  }
  return invoker.run(useCases.createBulk, principal, { locale: String(form.get('locale')), items });
}

/** Only pending or explicitly retryable effects need a request. Success is never repeated. */
export function nextBulkSlot(
  items: readonly { apply: { retryable: boolean } | null; undo: { retryable: boolean } | null }[],
  phase: 'apply' | 'undo'
): number | null {
  const pending = items.findIndex((item) => !item[phase]);
  const ordinal = pending >= 0 ? pending : items.findIndex((item) => item[phase]?.retryable);
  return ordinal < 0 ? null : ordinal;
}
