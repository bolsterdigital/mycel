// What the admin's error page needs when a preview route refuses or fails: the operator's language
// and address, as in the admin's own layout. A preview page renders a site, not the admin, so it
// shares that page and not the layout. Rejected: a preview route per error, or the framework's
// default page, which shows the bare code to an editor.
import { langOf } from '../../i18n/index.js';
import type { LayoutServerLoad } from './$types';

// No client script on an error page either, as on the preview pages.
export const csr = false;

export const load: LayoutServerLoad = ({ locals }) => ({
  locale: langOf(locals),
  email: locals.session?.email ?? null,
});
