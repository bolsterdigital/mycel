// The cached read route of ADR 012 rule 7 (brief #8c § 10): published content as JSON for an
// app, an exporter or an agent, without an API key, apart from the use-case routes.
//
//   GET /v1/sites/{tenant}/content/{type}/{slug}?locale=
//
// The tenant comes from the path, looked up by slug in the tenant directory; the route builds
// that site's anonymous visitor (`content:read`, with the site's entitlements and status, as the
// web front does) and runs `content.published.get`, the one projection every representation
// derives from. No Authorization header is read: a key of tenant A opens nothing more of tenant
// B, and nothing less of anyone, than an anonymous request does.
//
// Caching matches the HTML of the site (brief § 9): `public` with a strong ETag of revision,
// locale and a digest of the body (authors' names and the section live outside the revision),
// and a 304 on If-None-Match. Unknown tenant, unknown item, unpublished locale and restricted
// item are one indistinguishable 404, `no-store`, so a later publication is not hidden behind a
// cached miss. Rejected: an API key per reader (public content needs none, and a key in an app
// leaks), and the use-case route `GET /v1/content.published.get` with its `private` cache
// (it answers per caller, this route per URL).

import { Hono } from 'hono';
import {
  UseCaseError,
  anonymousPrincipal,
  useCases,
  type Invoker,
  type TenantAccess,
  type TenantDirectory,
} from '@mycel/core';
import { conditionalJson, etag } from './http-shape.js';
import { problem } from './problem.js';

export interface ContentReadDeps {
  invoker: Invoker;
  tenants: Pick<TenantDirectory, 'findBySlug'>;
  /** The tenant's entitlements and status, for its visitor's Principal (ADR 015 rule 3). */
  access(tenantId: string): Promise<TenantAccess>;
}

export const CONTENT_READ_PATH = '/v1/sites/{tenant}/content/{type}/{slug}';
const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=600';
const NO_STORE = 'no-store';

/** Mounted under `/v1/sites` by `createApp`. */
export function createContentReadApp({ invoker, tenants, access }: ContentReadDeps): Hono {
  const app = new Hono();
  const missing = () =>
    problem('not_found', 'no published content at this address', [], {
      'cache-control': NO_STORE,
    });

  app.get('/:tenant/content/:type/:slug', async (c) => {
    const { type, slug } = c.req.param();
    if (type !== 'page' && type !== 'article') return missing();
    const tenant = await tenants.findBySlug(c.req.param('tenant'));
    if (!tenant) return missing();
    const visitor = anonymousPrincipal({ id: tenant.id, ...(await access(tenant.id)) }, [
      'content:read',
    ]);
    const locale = c.req.query('locale');
    let body: string;
    let key: string;
    try {
      const item = await invoker.run(useCases.getPublished, visitor, {
        type,
        slug,
        ...(locale === undefined ? {} : { locale }),
      });
      body = JSON.stringify(item);
      key = `${item.revisionId}:${item.locale}`;
    } catch (e) {
      if (e instanceof UseCaseError && e.code === 'not_found') return missing();
      if (e instanceof UseCaseError)
        return problem(e.code, e.message, e.issues, { 'cache-control': NO_STORE });
      throw e;
    }
    return conditionalJson(c.req.header('if-none-match'), body, {
      etag: etag(body, key),
      'cache-control': PUBLIC_CACHE,
    });
  });

  return app;
}
