// Live preview accepts the native edit form as an unsaved document. The same pure form mapper and
// public resolver as saved preview are used, but no content write occurs. Rejected: persisting a
// temporary revision or rendering client HTML, either of which would change the publication or
// trust boundary. Membership and content:write are checked for every POST, including iframe posts.
import { error } from '@sveltejs/kit';
import {
  ContentDocumentInput,
  UseCaseError,
  can,
  projectDocument,
  readinessIssues,
  useCases,
  type ContentDocument,
} from '@mycel/core';
import { resolveDocument, resolveIntro, runtimeSource } from '#lib/blocks/resolve.js';
import { posted } from '#lib/editor/block-form.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { text } from '#lib/server/admin/admin-actions.js';
import { valuesFromForm } from '#lib/server/content-admin.js';
import { formDocument } from '#lib/server/edit-form.js';
import {
  PREVIEW_HEADERS,
  previewBase,
  previewSite,
  siteReader,
  introOf,
} from '#lib/server/preview.js';
import { runtime } from '#lib/server/runtime.js';
import { siteBrand, siteTheme } from '#lib/server/theme.js';
import { ui } from '../../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const csr = false;

export const load: PageServerLoad = async ({ locals, url, params, setHeaders }) => {
  setHeaders(PREVIEW_HEADERS);
  await requireTenantPrincipal(locals, url, params.tenant);
  return { admin: locals.lang ?? 'en' };
};

export const actions: Actions = {
  default: async ({ locals, url, params, request }) => {
    const { tenant, principal } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'content:write')) error(403, 'Forbidden');
    const data = await request.formData();
    const itemId = text(data, 'itemId');
    const revisionId = text(data, 'baseRevisionId');
    const locale = text(data, 'previewLocale');
    if (!UUID.test(itemId) || !UUID.test(revisionId)) error(400, 'Invalid document');
    const rt = runtime();
    let item, revision;
    try {
      ({ item, revision } = await rt.invoker.run(useCases.getItem, principal, {
        itemId,
        revisionId,
      }));
    } catch (e) {
      if (e instanceof UseCaseError && e.code === 'not_found') error(403, 'Forbidden');
      if (e instanceof UseCaseError && e.code === 'forbidden') error(403, 'Forbidden');
      throw e;
    }
    // The edit form carries every block's fields (#66 PR 2) in the one locale it shows (PR 4);
    // a block it reads back unchanged keeps its exact props, and every other locale is the
    // revision's, so previewing a title never normalizes rich text or another locale.
    const read = formDocument(
      revision.document,
      valuesFromForm(data),
      posted(data),
      new Date().toISOString().slice(0, 10),
      data.has('editLocale') ? text(data, 'editLocale') || null : undefined
    );
    if (read.errors.length) error(400, 'Invalid block');
    const input = read.document;
    const parsed = ContentDocumentInput.safeParse(input);
    if (!parsed.success) error(400, 'Invalid document');
    const doc = parsed.data as ContentDocument;
    if (!doc.locales.includes(locale)) error(400, 'Invalid locale');

    const site = await previewSite(tenant);
    const base = previewBase(tenant.slug);
    const source = runtimeSource({
      invoker: rt.invoker,
      uow: rt.uow,
      reader: siteReader(site),
      defaultLocale: tenant.defaultLocale,
    });
    const live = item.publication.find((p) => p.locale === locale)?.publishedAt ?? null;
    const [model, intro, theme] = await Promise.all([
      resolveDocument(
        source,
        { locale, ...projectDocument(doc, locale) },
        { base, fallbackLocale: tenant.defaultLocale }
      ),
      introOf(principal, doc, locale, live).then((intro) => resolveIntro(source, intro, locale)),
      siteTheme(site),
    ]);
    const brand = await siteBrand(site);
    const admin = locals.lang ?? 'en';
    locals.lang = locale;
    return {
      admin,
      locale,
      model,
      intro,
      dropCap: doc.type === 'article' && theme.dropCap === 'articles',
      issues: readinessIssues(doc, locale).map((issue) => issue.path),
      theme: { href: `${base}/_theme/${theme.hash}.css`, preload: theme.preload },
      brand: {
        name: tenant.name,
        logo: brand.logo.active ? `${base}/_brand/logo/${brand.logo.version}.webp` : null,
        width: brand.logo.width,
        height: brand.logo.height,
        wordmark: brand.font.active,
      },
      formNote: ui(admin)('admin.content.preview.form'),
    };
  },
};
