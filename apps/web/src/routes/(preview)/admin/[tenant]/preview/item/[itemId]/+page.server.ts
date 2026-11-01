// One revision of an item in one locale, as the site will show it (lib/server/preview.ts). The
// operator needs `content:read` on this site; an unknown item, revision or locale is a 404. The
// locale's readiness issues (ADR 018 rule 9) are listed above the page, and a block that has no
// value in this locale yet is left out of it (`projectDocument`).
import { error } from '@sveltejs/kit';
import { UseCaseError, projectDocument, readinessIssues, useCases } from '@mycel/core';
import { adminTimeZone, requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { actorLabel, when } from '#lib/server/content-admin.js';
import {
  PREVIEW_HEADERS,
  previewBase,
  previewSite,
  siteReader,
  introOf,
} from '#lib/server/preview.js';
import { runtime } from '#lib/server/runtime.js';
import { siteBrand, siteTheme } from '#lib/server/theme.js';
import { resolveDocument, resolveIntro, runtimeSource } from '#lib/blocks/resolve.js';
import { ui } from '../../../../../../../i18n/index.js';
import type { PageServerLoad } from './$types';

export const csr = false;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const load: PageServerLoad = async ({ locals, url, params, setHeaders }) => {
  setHeaders(PREVIEW_HEADERS);
  const { tenant, principal } = await requireTenantPrincipal(locals, url, params.tenant);
  const revisionId = url.searchParams.get('revision');
  if (!UUID.test(params.itemId) || (revisionId !== null && !UUID.test(revisionId)))
    error(404, 'Not found');
  const rt = runtime();
  let got;
  try {
    got = await rt.invoker.run(useCases.getItem, principal, {
      itemId: params.itemId,
      ...(revisionId ? { revisionId } : {}),
    });
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') error(404, 'Not found');
    if (e instanceof UseCaseError && e.code === 'forbidden') error(403, 'Forbidden');
    throw e;
  }
  const { item, revision } = got;
  const doc = revision.document;
  const locale = url.searchParams.get('locale') ?? doc.defaultLocale;
  if (!doc.locales.includes(locale)) error(404, 'Not found');

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
  const intro = await resolveIntro(source, await introOf(site, doc, locale, live), locale);
  const theme = await siteTheme(site);
  const brand = await siteBrand(site);
  const admin = locals.lang ?? 'en';
  locals.lang = locale;
  return {
    admin,
    model,
    intro,
    dropCap: doc.type === 'article' && theme.dropCap === 'articles',
    theme: { href: `${base}/_theme/${theme.hash}.css`, preload: theme.preload },
    brand: {
      name: tenant.name,
      logo: brand.logo.active ? `${base}/_brand/logo/${brand.logo.version}.webp` : null,
      width: brand.logo.width,
      height: brand.logo.height,
      wordmark: brand.font.active,
    },
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
