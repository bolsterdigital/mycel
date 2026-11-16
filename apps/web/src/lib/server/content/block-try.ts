// A block operation of the edit screen after the save of its one form: a use-case refusal comes
// back as the screen's failure (a conflict with who saved in between), anything else is thrown.
// Shared by the route's block steps and the pattern steps (`lib/server/patterns/editor.ts`).
// Apart from the route, which is at its size ceiling.

import type { Principal } from '@mycel/core';
import { fail } from '@sveltejs/kit';
import { failureOf } from '#lib/server/admin/admin-actions.js';
import { changesSince } from '#lib/server/content/conflict/merge-conflict.js';
import { blockRefusalIssues } from '#lib/server/content/edit-form.js';
import { refusalOf } from '#lib/server/http/refuse.js';
import type { UiKey } from '../../../i18n/index.js';

/** What a block step needs from the save before it. */
export interface Saved {
  principal: Principal;
  /** The revision the step runs on: the save's, or the one the form was opened on. */
  revisionId: string;
  locals: App.Locals;
}

export async function blockTry(
  saved: Saved,
  itemId: string,
  run: () => Promise<void>,
  issues: Record<string, UiKey> = {}
) {
  const { principal, revisionId: from, locals } = saved;
  try {
    await run();
    return null;
  } catch (e) {
    const refusal = refusalOf(e);
    const fieldIssues = blockRefusalIssues(refusal);
    const { status, body } = failureOf(refusal, 'block', {
      conflict: 'admin.content.conflict.title',
      invalid: fieldIssues.length ? 'admin.block.error.invalid' : 'admin.content.error.invalid',
      issues,
    });
    const conflict =
      refusal.code === 'conflict' ? await changesSince(principal, itemId, from, locals) : null;
    return fail(status, { ...body, fieldIssues, conflict: conflict?.view ?? null });
  }
}
