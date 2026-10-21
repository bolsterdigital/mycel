// POST /admin/logout clears the session cookie. No RP-initiated logout at the IdP (brief #7,
// out of scope): the IdP session stays, so "log in again" may not ask for a password.
import { SESSION_COOKIE, clearCookie } from '#lib/server/admin.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => ({ signedIn: !!locals.session });

export const actions: Actions = {
  default: ({ cookies }) => {
    clearCookie(cookies, SESSION_COOKIE);
    return { loggedOut: true };
  },
};
