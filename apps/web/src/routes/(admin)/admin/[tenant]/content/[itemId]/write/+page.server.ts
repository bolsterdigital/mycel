// Retain old writer bookmarks while keeping every edit in the one document form.
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = ({ params, url }) => {
  redirect(303, `/admin/${params.tenant}/content/${params.itemId}${url.search}#blocks`);
};
