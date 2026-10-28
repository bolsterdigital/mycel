// One page pattern of the catalogue (brief #56 § B) on a page of its own, because a pattern is a
// whole screen with its own <main> and <h1>. The forms post to a `save` action that only echoes
// which section was saved, so the confirmation of the settings and form patterns can be seen and
// measured without touching a tenant's data.
import { error } from '@sveltejs/kit';
import { PATTERNS } from '../patterns.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, params, url }) => {
  await parent();
  const pattern = PATTERNS.find((p) => p === params.pattern);
  if (!pattern) error(404, 'Not Found');
  return { pattern, view: url.searchParams.get('view') === 'list' ? 'list' : 'grid' };
};

export const actions: Actions = {
  save: async ({ request }) => {
    const section = (await request.formData()).get('section');
    return { saved: typeof section === 'string' ? section : '' };
  },
};
