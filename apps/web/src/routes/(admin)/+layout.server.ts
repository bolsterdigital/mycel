// The operator admin (TODO #7) is server-rendered with form actions and no client JavaScript,
// like the public pages (ADR 009 rule 1): every action works without it. TODO #11 builds the
// real admin; this layout only carries what the error page and the header need.
import { langOf } from '../../i18n/index.js';
import type { LayoutServerLoad } from './$types';

export const csr = false;

export const load: LayoutServerLoad = ({ locals }) => ({
  locale: langOf(locals),
  email: locals.session?.email ?? null,
});
