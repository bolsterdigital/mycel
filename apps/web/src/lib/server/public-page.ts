// Loads a public page as a render model (brief #8c § 1): the core chooses the locale among the
// published ones and returns only that locale (`content.page.get`), and the resolver fetches every
// reference the blocks make once, up front, so components never see a `{ nl, en }` map, a
// restricted media path or a link to an unpublished item. The public pages ship no client-side
// JavaScript at all. Locale routing comes with #8c2; until then the probe's route negotiates.

import { error } from '@sveltejs/kit';
import {
  UseCaseError,
  anonymousPrincipal,
  useCases,
  type PublishedPage,
  type TenantInfo,
} from '@mycel/core';
import type { RenderModel } from '../blocks/model.js';
import { resolveDocument, runtimeSource } from '../blocks/resolve.js';
import { runtime } from './runtime.js';
import { sitePath, siteTenant, type Site } from './site.js';

export interface PublicPage {
  tenant: TenantInfo;
  page: PublishedPage;
  locale: string;
  model: RenderModel;
}

/** The site comes from the hooks (hostname or dev path, ADR 014), never from a route param. */
export async function loadPublicPage(
  site: Site,
  slug: string,
  acceptLanguage: string | null
): Promise<PublicPage> {
  const { invoker, uow } = runtime();
  const { tenant } = site;
  const reader = anonymousPrincipal(siteTenant(site), ['content:read', 'forms:read', 'media:read']);
  let page: PublishedPage;
  try {
    page = await invoker.run(useCases.getPage, reader, {
      slug,
      ...(acceptLanguage ? { acceptLanguage: acceptLanguage.slice(0, 500) } : {}),
    });
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') error(404, 'Not found');
    throw e;
  }
  const model = await resolveDocument(runtimeSource({ invoker, uow, reader }), page, {
    base: sitePath(site, ''),
    fallbackLocale: tenant.defaultLocale,
  });
  return { tenant, page, locale: page.locale, model };
}
