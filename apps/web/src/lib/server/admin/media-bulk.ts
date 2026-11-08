// The selection of the media library for its bulk actions: the rows ticked on the page
// that was open, or all of them, at most the use cases' 100 and never a query to run later.
// The confirmation is a GET, so ticking and leaving changes nothing; the POST behind it is safe to
// send twice, because `media.bulk.delete` reports an asset already in the trash as deleted.
import { isUuid, useCases, type Principal } from '@mycel/core';
import { orNull } from '#lib/server/admin/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';

export const BULK_MAX = 100;

export function selectedMediaIds(params: URLSearchParams): string[] {
  const asked = params.has('all') ? params.getAll('visible') : params.getAll('selected');
  return [...new Set(asked.filter(isUuid))].slice(0, BULK_MAX);
}

export function postedMediaIds(form: FormData): string[] {
  return [...new Set(form.getAll('selected').map(String).filter(isUuid))].slice(0, BULK_MAX);
}

/** The live assets among `ids`, in that order; what is gone is simply not offered. */
export async function liveMedia(principal: Principal, ids: readonly string[]) {
  const { invoker } = runtime();
  const found = await Promise.all(
    ids.map((id) => orNull(invoker.run(useCases.getMedia, principal, { id })))
  );
  return found.filter((m) => m !== null);
}

/** Only a query string, so the list link can never leave the library. */
export const mediaListHref = (tenant: string, back: string | null) =>
  `/admin/${tenant}/media${back && !/[/\\#]/.test(back) ? `?${back}` : ''}`;
