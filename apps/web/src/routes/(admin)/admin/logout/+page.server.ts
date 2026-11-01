// POST /admin/logout clears the session cookie. No RP-initiated logout at the IdP (brief #7,
// out of scope): the IdP session stays, so "log in again" may not ask for a password. The browser
// is also told to drop what this origin kept (`CLEAR_ON_LOGOUT`), for the next person at a shared
// computer.
import { SESSION_COOKIE, clearCookie } from '#lib/server/admin/admin.js';
import { CLEAR_ON_LOGOUT } from '#lib/server/http/security-headers.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => ({ signedIn: !!locals.session });

export const actions: Actions = {
  default: ({ cookies, setHeaders }) => {
    clearCookie(cookies, SESSION_COOKIE);
    setHeaders({ 'clear-site-data': CLEAR_ON_LOGOUT });
    return { loggedOut: true };
  },
};
