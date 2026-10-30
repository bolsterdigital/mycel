// The dashboard (#66 PR 1, decision Jaap 2026-10-29): the tenant home shows its widgets before
// their data. Only "Usage and limits" has data yet, the usage the tenant home already showed;
// the use case is for site administrators, so another member sees that widget empty, like the
// rest. Members, keys and domains moved verbatim to `leden` and `domeinen`.
// Rejected: a dashboard use case now (nothing to aggregate until the widgets are designed).
import { useCases } from '@mycel/core';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  const { capabilities } = await parent();
  const usage = capabilities.includes('tenant:admin')
    ? await runtime().invoker.run(useCases.getUsage, locals.principal!, {})
    : null;
  return { usage };
};
