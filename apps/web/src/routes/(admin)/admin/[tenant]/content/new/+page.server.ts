// A new page or article (TODO #11, brief content-editor § A1): type, a title per locale of the
// site, an optional slug (derived from the title when empty) and which locales the item has, optionally from one of the site's patterns. The item
// starts as a draft with its first revision; the answer is a 303 to its edit page. A refusal
// re-renders the form with what was typed.
//
// An article can also start from the standard long read of ADR 012 rule 8, built for the chosen
// locales and sent as the document's blocks; a saved pattern goes to core as `patternId`. The
// choice and the long read are shared with the empty column of the editor
// (`lib/server/patterns/choice.ts`).
//
// The photo story (also rule 8) needs the site's photos with a description per locale: chosen
// without them, the form comes back with one sentence and the photo slots, which offer the site's
// images; with them, core's factory builds the blocks (`lib/server/patterns/photo-story.ts`).
import { fail, redirect } from '@sveltejs/kit';
import { ContentType, can, useCases, type ContentDocumentInput } from '@mycel/core';
import {
  LONG_READ,
  PHOTO_STORY,
  patternChoices,
  standardBlocks,
} from '#lib/server/patterns/choice.js';
import { PHOTO_SLOTS, storyPhotos } from '#lib/server/patterns/photo-story.js';
import { mediaChoices } from '#lib/server/content/content-blocks.js';
import { failureOf } from '#lib/server/admin/admin-actions.js';
import { refusalOf } from '#lib/server/http/refuse.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { valuesFromForm } from '#lib/server/content/content-admin.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, url }) => {
  const { locale, tenant } = await parent();
  const type = ContentType.safeParse(url.searchParams.get('type')).data ?? 'page';
  const patterns = await patternChoices(locals.principal!, type, [locale, tenant.defaultLocale]);
  return { type, contentType: type, patterns };
};

/** Core's issue keys on a create, as admin copy. */
const ISSUES: Record<string, UiKey> = {
  'content.slug.invalid': 'admin.content.error.slugInvalid',
  'content.slug.reserved': 'admin.content.error.slugReserved',
  'i18n.default-not-in-locales': 'admin.content.error.defaultLocale',
};

export const actions: Actions = {
  default: async ({ locals, url, params, request }) => {
    const { tenant, principal } = await requireTenantPrincipal(locals, url, params.tenant);
    const values = valuesFromForm(await request.formData());
    const one = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : '');
    const type = ContentType.safeParse(one('type')).data ?? 'page';
    const locales = tenant.locales.filter((l) => (values.locales as string[]).includes(l));
    const title = Object.fromEntries(
      locales.flatMap((l) => (one(`title.${l}`).trim() ? [[l, one(`title.${l}`).trim()]] : []))
    );
    const pattern = one('patternId');
    const story = pattern === PHOTO_STORY ? storyPhotos(values, locales) : null;
    // A refused photo story comes back with its slots and what was chosen in them.
    const slots = async () => ({
      photos: story && {
        slots: PHOTO_SLOTS,
        media: await mediaChoices(
          principal,
          story.photos.map((p) => p.mediaId)
        ),
        upload: can(principal, 'media:write'),
      },
    });
    let blocks: ReturnType<typeof standardBlocks>;
    try {
      blocks = standardBlocks(pattern, type, locales, story?.problem ? [] : story?.photos);
    } catch {
      // A tampered media id fails core's schema: the form's general refusal, not a 500.
      const error: UiKey = 'admin.content.error.invalid';
      return fail(400, { action: 'create', error, values, ...(await slots()) });
    }
    if (story && !blocks) {
      const error: UiKey =
        story.problem === 'alt'
          ? 'admin.content.new.photoStory.alt'
          : 'admin.content.new.photoStory.none';
      return fail(400, { action: 'create', error, values, ...(await slots()) });
    }
    const document = {
      type,
      title,
      defaultLocale: tenant.defaultLocale,
      locales,
      blocks: blocks ?? [],
    } as unknown as ContentDocumentInput;
    let id: string;
    try {
      // An empty slug is derived from the title by core (editor trial 2026-10-28).
      const slug = one('slug').trim();
      const r = await runtime().invoker.run(useCases.createItem, principal, {
        ...(slug ? { slug } : {}),
        document,
        ...(pattern && pattern !== LONG_READ && pattern !== PHOTO_STORY
          ? { patternId: pattern }
          : {}),
      });
      id = r.item.id;
    } catch (e) {
      const { status, body } = failureOf(refusalOf(e), 'create', {
        conflict: 'admin.content.error.slugTaken',
        invalid: 'admin.content.error.invalid',
        issues: ISSUES,
      });
      return fail(status, { ...body, values, ...(await slots()) });
    }
    redirect(303, `/admin/${tenant.slug}/content/${id}`);
  },
};
