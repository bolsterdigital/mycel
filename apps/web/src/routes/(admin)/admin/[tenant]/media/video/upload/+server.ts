// The control plane holds small JSON envelopes. Tus sends the bytes straight to Bunny.
import { useCases } from '@mycel/core';
import { json } from '@sveltejs/kit';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { refusalOf } from '#lib/server/http/refuse.js';
import { runtime } from '#lib/server/runtime.js';
import type { RequestHandler } from './$types';

const operations = {
  create: useCases.createVideo,
  check: useCases.checkVideo,
  resume: useCases.resumeVideo,
};
const headers = { 'cache-control': 'private, no-store' };

export const POST: RequestHandler = async ({ locals, url, params, request }) => {
  const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
  const operation = url.searchParams.get('operation');
  const invoke = runtime().invoker;
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json({ code: 'invalid_input' }, { status: 400, headers });
  }
  try {
    if (operation !== 'create' && operation !== 'check' && operation !== 'resume')
      return json({ code: 'not_found' }, { status: 404, headers });
    return json(await invoke.call(principal, operations[operation].name, input), { headers });
  } catch (e) {
    const { code } = refusalOf(e);
    return json(
      { code },
      {
        status:
          code === 'invalid_input'
            ? 400
            : code === 'not_found'
              ? 404
              : code === 'conflict'
                ? 409
                : 403,
        headers,
      }
    );
  }
};
