// The view a list was left in, for the way back from one of its rows: what the content list and
// the media library share. A cookie scoped to the site's admin, written only when a row opens with
// the list as its Referer and only if the value changes; why that and nothing cheaper is at the
// top of `content/content-list.ts`.
import type { Cookies } from '@sveltejs/kit';

/** A working day: tomorrow the list opens as it is, not as it was left. */
const REMEMBERED_SECONDS = 60 * 60 * 12;

/** Keeps `query` under `name`; an empty query forgets what was kept. */
export function keepListQuery(cookies: Cookies, name: string, tenant: string, query: string): void {
  const path = `/admin/${tenant}`;
  const kept = cookies.get(name);
  if (kept === query || (!query && kept === undefined)) return;
  if (!query) {
    cookies.delete(name, { path });
    return;
  }
  cookies.set(name, query, {
    path,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: REMEMBERED_SECONDS,
  });
}
