// One revision of an item in one locale, as the site will show it (lib/server/content/preview.ts). The
// operator needs `content:read` on this site; an unknown item, revision or locale is a 404. The
// locale's readiness issues (ADR 018 rule 9) are listed above the page, and a block that has no
// value in this locale yet is left out of it (`projectDocument`).
import { isUuid, projectDocument, readinessIssues, useCases } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { adminTimeZone, requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { actorLabel, when } from '#lib/server/content/content-admin.js';
import {
  PREVIEW_HEADERS,
  previewBase,
  previewSite,
  siteReader,
  introOf,
} from '#lib/server/content/preview.js';
import { runtime } from '#lib/server/runtime.js';
import { chromeModel } from '#lib/server/public/chrome.js';
import { siteTheme } from '#lib/server/public/theme.js';
import { resolveDocument, resolveIntro, runtimeSource } from '#lib/blocks/resolve.js';
import { langOf, ui } from '../../../../../../../i18n/index.js';
import type { PageServerLoad } from './$types';
import { refuse } from '#lib/server/http/refuse.js';

export const csr = false;

export const load: PageServerLoad = async ({ locals, url, params, setHeaders }) => {
  setHeaders(PREVIEW_HEADERS);
  const { tenant, principal } = await requireTenantPrincipal(locals, url, params.tenant);
  const revisionId = url.searchParams.get('revision');
  if (!isUuid(params.itemId) || (revisionId !== null && !isUuid(revisionId))) refuse(404);
  const rt = runtime();
  const { item, revision } = await loaded(
    rt.invoker.run(useCases.getItem, principal, {
      itemId: params.itemId,
      ...(revisionId ? { revisionId } : {}),
    })
  );
  const doc = revision.document;
  const locale = url.searchParams.get('locale') ?? doc.defaultLocale;
  if (!doc.locales.includes(locale)) refuse(404);

  const site = await previewSite(tenant);
  const base = previewBase(tenant.slug);
  const source = runtimeSource({
    invoker: rt.invoker,
    uow: rt.uow,
    reader: siteReader(site),
    defaultLocale: tenant.defaultLocale,
  });
  const model = await resolveDocument(
    source,
    { locale, ...projectDocument(doc, locale) },
    { base, fallbackLocale: tenant.defaultLocale }
  );
  const live = item.publication.find((p) => p.locale === locale)?.publishedAt ?? null;
  const intro = await resolveIntro(source, await introOf(principal, doc, locale, live), locale);
  const theme = await siteTheme(site);
  const admin = langOf(locals);
  locals.lang = locale;
  return {
    admin,
    model,
    intro,
    dropCap: doc.type === 'article' && theme.dropCap === 'articles',
    theme: { href: `${base}/_theme/${theme.hash}.css`, preload: theme.preload },
    ...(await chromeModel(site, locale, base)),
    issues: readinessIssues(doc, locale).map((i) => i.path),
    revision: {
      when: when(revision.createdAt, (await adminTimeZone(locals)).zone),
      who: actorLabel(revision.actor),
      latest: revision.id === item.latestRevisionId,
      // Which version this is (#66 PR 6d): what visitors see in this locale, the saved draft
      // after it, or an older revision.
      kind:
        item.publication.find((p) => p.locale === locale)?.publishedRevisionId === revision.id
          ? ('live' as const)
          : revision.id === item.latestRevisionId
            ? ('draft' as const)
            : ('older' as const),
    },
    locale,
    edit: `/admin/${tenant.slug}/content/${item.id}`,
    formNote: ui(admin)('admin.content.preview.form'),
  };
};
