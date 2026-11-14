// A new page or article (TODO #11, brief content-editor § A1): type, a title per locale of the
// site, an optional slug (derived from the title when empty) and which locales the item has, optionally from one of the site's patterns. The item
// starts as a draft with its first revision; the answer is a 303 to its edit page. A refusal
// re-renders the form with what was typed.
//
// An article can also start from the standard long read of ADR 012 rule 8. It is core's factory,
// built here for the chosen locales and sent as the document's blocks, so every site has it
// without a saved pattern. Rejected: saving it as a pattern when a tenant is created, which
// existing tenants would miss and an editor could delete.
import { fail, redirect } from '@sveltejs/kit';
import {
  ContentType,
  MAX_PAGE_SIZE,
  longReadPattern,
  useCases,
  type ContentDocumentInput,
} from '@mycel/core';
import { failureOf } from '#lib/server/admin/admin-actions.js';
import { refusalOf } from '#lib/server/http/refuse.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { valuesFromForm } from '#lib/server/content/content-admin.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

/** The value of the standard long-read choice; not a pattern id, so it never reaches core. */
const LONG_READ = 'standard:long-read';

export const load: PageServerLoad = async ({ parent, locals, url }) => {
  await parent();
  const { patterns } = await runtime().invoker.run(useCases.listPatterns, locals.principal!, {
    limit: MAX_PAGE_SIZE,
  });
  const type = ContentType.safeParse(url.searchParams.get('type')).data ?? 'page';
  return {
    type,
    contentType: type,
    patterns: patterns.map((p) => ({ id: p.id, type: p.intendedType, name: p.name })),
    longRead: LONG_READ,
  };
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
    // Only for an article, and only with a locale: without one core refuses the locales anyway.
    const longRead = pattern === LONG_READ && type === 'article' && locales.length > 0;
    const document = {
      type,
      title,
      defaultLocale: tenant.defaultLocale,
      locales,
      blocks: longRead ? longReadPattern(locales).blocks : [],
    } as unknown as ContentDocumentInput;
    let id: string;
    try {
      // An empty slug is derived from the title by core (editor trial 2026-10-28).
      const slug = one('slug').trim();
      const r = await runtime().invoker.run(useCases.createItem, principal, {
        ...(slug ? { slug } : {}),
        document,
        ...(pattern && pattern !== LONG_READ ? { patternId: pattern } : {}),
      });
      id = r.item.id;
    } catch (e) {
      const { status, body } = failureOf(refusalOf(e), 'create', {
        conflict: 'admin.content.error.slugTaken',
        invalid: 'admin.content.error.invalid',
        issues: ISSUES,
      });
      return fail(status, { ...body, values });
    }
    redirect(303, `/admin/${tenant.slug}/content/${id}`);
  },
};
