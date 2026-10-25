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
import { resolveDocument, runtimeSource } from '#lib/blocks/resolve.js';
import { posted, propsFromForm } from '#lib/editor/block-form.js';
import { BLOCK_DEFINITIONS } from '@mycel/core';
import { requireTenantPrincipal } from '#lib/server/admin.js';
import { text } from '#lib/server/admin-actions.js';
import { documentFrom, valuesFromForm } from '#lib/server/content-admin.js';
import { PREVIEW_HEADERS, previewBase, previewSite, siteReader } from '#lib/server/preview.js';
import { runtime } from '#lib/server/runtime.js';
import { siteTheme } from '#lib/server/theme.js';
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
    let revision;
    try {
      ({ revision } = await rt.invoker.run(useCases.getItem, principal, { itemId, revisionId }));
    } catch (e) {
      if (e instanceof UseCaseError && e.code === 'not_found') error(403, 'Forbidden');
      if (e instanceof UseCaseError && e.code === 'forbidden') error(403, 'Forbidden');
      throw e;
    }
    const input = documentFrom(
      revision.document,
      valuesFromForm(data),
      new Date().toISOString().slice(0, 10)
    );
    // Only block forms changed in this browser session are applied. Untouched blocks keep their
    // exact props; previewing a title cannot silently normalize rich text or another locale.
    for (const block of input.blocks) {
      const prefix = `draftBlock.${block.id}.`;
      const fields = [...data.entries()].filter(([name]) => name.startsWith(prefix));
      if (!fields.length) continue;
      const blockData = new FormData();
      for (const [name, value] of fields) blockData.append(name.slice(prefix.length), value);
      const result = propsFromForm(
        BLOCK_DEFINITIONS[block.type].fields,
        posted(blockData),
        block.props as Record<string, unknown>
      );
      if (result.errors.length) error(400, 'Invalid block');
      (block as { props: Record<string, unknown> }).props = result.props;
    }
    const parsed = ContentDocumentInput.safeParse(input);
    if (!parsed.success) error(400, 'Invalid document');
    const doc = parsed.data as ContentDocument;
    if (!doc.locales.includes(locale)) error(400, 'Invalid locale');

    const site = await previewSite(tenant);
    const base = previewBase(tenant.slug);
    const [model, theme] = await Promise.all([
      resolveDocument(
        runtimeSource({
          invoker: rt.invoker,
          uow: rt.uow,
          reader: siteReader(site),
          defaultLocale: tenant.defaultLocale,
        }),
        { locale, ...projectDocument(doc, locale) },
        { base, fallbackLocale: tenant.defaultLocale }
      ),
      siteTheme(site),
    ]);
    const admin = locals.lang ?? 'en';
    locals.lang = locale;
    return {
      admin,
      locale,
      model,
      issues: readinessIssues(doc, locale).map((issue) => issue.path),
      theme: { href: `${base}/_theme/${theme.hash}.css`, preload: theme.preload },
      formNote: ui(admin)('admin.content.preview.form'),
    };
  },
};
