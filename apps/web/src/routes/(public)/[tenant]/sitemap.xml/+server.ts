// The profile part of the site's sitemap. Content entries will extend this same route when
// general content discovery ships; rejected: exposing editorial people or draft content here.
import { createHash } from 'node:crypto';
import { anonymousPrincipal, useCases } from '@mycel/core';
import { personPath } from '#lib/public/person-path.js';
import { PUBLIC_CACHE } from '#lib/server/http/http-cache.js';
import { runtime } from '#lib/server/runtime.js';
import { requireSite, siteTenant, siteUrls } from '#lib/server/site.js';
import type { RequestHandler } from './$types';

const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!
  );
export const GET: RequestHandler = async ({ locals }) => {
  const site = requireSite(locals);
  const reader = anonymousPrincipal(siteTenant(site), ['content:read']);
  const absolute = await siteUrls(site);
  const urls: string[] = [];
  for (const locale of site.tenant.locales) {
    let after: string | undefined;
    do {
      const page = await runtime().invoker.run(useCases.listPublicPeople, reader, {
        locale,
        after,
        limit: 100,
      });
      urls.push(
        ...page.people.map(
          (person) =>
            `<url><loc>${xml(absolute(personPath(person.slug, locale, site.tenant.defaultLocale)))}</loc></url>`
        )
      );
      after = page.next ?? undefined;
    } while (after);
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`;
  return new Response(body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': PUBLIC_CACHE,
      etag: `"${createHash('sha256').update(body).digest('base64url')}"`,
    },
  });
};
