// Live preview accepts the native edit form as an unsaved document. The same pure form mapper and
// public resolver as saved preview are used, but no content write occurs. Rejected: persisting a
// temporary revision or rendering client HTML, either of which would change the publication or
// trust boundary. Membership and content:write are checked for every POST, including iframe posts.
import {
  ContentDocumentInput,
  can,
  projectDocument,
  readinessIssues,
  useCases,
  type ContentDocument,
  isUuid,
} from '@mycel/core';
import { resolveDocument, resolveIntro, runtimeSource } from '#lib/blocks/resolve.js';
import { posted } from '#lib/editor/block-form.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { error } from '@sveltejs/kit';
import { text } from '#lib/server/admin/admin-actions.js';
import { valuesFromForm } from '#lib/server/content/content-admin.js';
import { formDocument } from '#lib/server/content/edit-form.js';
import {
  campaignNotes,
  PREVIEW_HEADERS,
  previewBase,
  previewSite,
  siteReader,
  introOf,
} from '#lib/server/content/preview.js';
import { runtime } from '#lib/server/runtime.js';
import { chromeModel } from '#lib/server/public/chrome.js';
import { siteTheme } from '#lib/server/public/theme.js';
import { langOf, ui } from '../../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';
import { refuse, refusalOf } from '#lib/server/http/refuse.js';

export const csr = false;

export const load: PageServerLoad = async ({ locals, url, params, setHeaders }) => {
  setHeaders(PREVIEW_HEADERS);
  await requireTenantPrincipal(locals, url, params.tenant);
  return { admin: langOf(locals) };
};

export const actions: Actions = {
  default: async ({ locals, url, params, request }) => {
    const { tenant, principal } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'content:write')) refuse(403);
    const data = await request.formData();
    const itemId = text(data, 'itemId');
    const revisionId = text(data, 'baseRevisionId');
    const locale = text(data, 'previewLocale');
    if (!isUuid(itemId) || !isUuid(revisionId)) refuse(400);
    const rt = runtime();
    let item, revision;
    try {
      ({ item, revision } = await rt.invoker.run(useCases.getItem, principal, {
        itemId,
        revisionId,
      }));
    } catch (e) {
      const { code } = refusalOf(e);
      if (code === 'not_found' || code === 'forbidden') refuse(403);
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
    const invalid = () => error(400, ui(langOf(locals))('admin.preview.error.invalid'));
    if (read.errors.length) invalid();
    const input = read.document;
    const parsed = ContentDocumentInput.safeParse(input);
    if (!parsed.success) invalid();
    const doc = parsed.data as ContentDocument;
    if (!doc.locales.includes(locale)) invalid();

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
        { base, fallbackLocale: tenant.defaultLocale, diagnose: true }
      ),
      introOf(principal, doc, locale, live).then((intro) => resolveIntro(source, intro, locale)),
      siteTheme(site),
    ]);
    const admin = langOf(locals);
    locals.lang = locale;
    return {
      admin,
      locale,
      model,
      intro,
      dropCap: doc.type === 'article' && theme.dropCap === 'articles',
      issues: readinessIssues(doc, locale).map((issue) => issue.path),
      theme: { href: `${base}/_theme/${theme.hash}.css`, preload: theme.preload },
      ...(await chromeModel(site, locale, base)),
      formNote: ui(admin)('admin.content.preview.form'),
      campaignNotes: campaignNotes(admin),
    };
  },
};
