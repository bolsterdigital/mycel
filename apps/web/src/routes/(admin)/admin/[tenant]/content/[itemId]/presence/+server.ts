// One beat of the edit screen (ADR 029): reports this tab and answers who else is here and whether
// a newer revision exists. Same use case and authorization as the API and MCP. The screen works
// without this route: it only adds the notice. A POST answer is not cached; its header is set
// here because `no-store` on a fetch keeps the page out of the back/forward cache, and the hook
// would add that to any admin response without a header of its own, which costs a writer's unsaved
// text on the way back from the list. Rejected: a form action, whose response would carry the
// whole page's data every twenty seconds per open tab.
import { json } from '@sveltejs/kit';
import { UseCaseError, type PresenceView } from '@mycel/core';
import { refusalOf } from '#lib/server/http/refuse.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { presenceLines } from '#lib/server/content/presence.js';
import { runtime } from '#lib/server/runtime.js';
import type { RequestHandler } from './$types';

const NOT_NO_STORE = { 'cache-control': 'private, max-age=0' };

const STATUS: Partial<Record<UseCaseError['code'], number>> = {
  invalid_input: 400,
  not_found: 404,
};

export const POST: RequestHandler = async ({ locals, url, params, request }) => {
  const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const view = (await runtime().invoker.call(principal, 'content.presence.update', {
      itemId: params.itemId,
      sessionId: body['sessionId'],
      state: body['state'],
      baseRevisionId: body['baseRevisionId'],
    })) as PresenceView;
    return json(presenceLines(view), { headers: NOT_NO_STORE });
  } catch (e) {
    return json({}, { status: STATUS[refusalOf(e).code] ?? 403, headers: NOT_NO_STORE });
  }
};
