// AI assistance became a section of the site settings (brief #81 PR 3); an old link or bookmark
// lands there. The settings page checks the capability, so this redirect needs no session.
// Rejected: keeping the page as a copy (two forms for one setting) and a 404 (breaks bookmarks).
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) =>
  redirect(308, `/admin/${encodeURIComponent(params.tenant)}/site?section=assist`);
