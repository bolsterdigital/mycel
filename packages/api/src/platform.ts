// The platform API (ADR 015 rule 4, ADR 002 rule 4, TODO #16): how a hoster's billing system
// (for Bureau Bolster: the client portal) creates tenants and sets their entitlements and status.
// Mounted at `/platform/*` in the same Hono app, but outside the registry: these operations run
// under no tenant, so they are not use cases, not MCP tools and not in `/openapi.json` (that
// document describes the tenant API). They run as the `mycel_platform` role, entered from the
// authentication login; the API never holds the schema owner's credentials (ADR 011 rule 1).
// Their shape is in docs/reference/platform-api.md; the functions behind them are
// packages/db/src/platform.ts, which `npm run platform` calls too.
//
// One bearer token, PLATFORM_API_TOKEN, compared in constant time over SHA-256 digests (equal
// length whatever the caller sends). Without the variable the routes do not exist: a self-hoster
// manages tenants with the CLI. Every mutation is one line in the server log with the tenant id
// and what changed; the audit log of TODO #17 takes this over. Rejected: a `platform:admin`
// capability on an API key (keys are tenant data under forced RLS).

import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  EntitlementsDocument,
  TenantStatus,
  UseCaseError,
  noopLogger,
  zodIssues,
  type Entitlements,
  type ErrorReporter,
  type Logger,
} from '@mycel/core';
import { problem } from './problem.js';

/** A tenant as the platform API answers it: the stored document and the effective one. */
export interface PlatformTenantView {
  id: string;
  slug: string;
  name: string;
  defaultLocale: string;
  locales: string[];
  status: TenantStatus;
  primaryHostname: string | null;
  storedEntitlements: EntitlementsDocument;
  entitlements: Entitlements;
}

/** The platform functions of packages/db, bound to the authentication login (compose.ts). */
export interface PlatformStore {
  create(input: {
    slug: string;
    name: string;
    locales: string[];
    defaultLocale?: string | undefined;
    entitlements?: EntitlementsDocument | undefined;
  }): Promise<PlatformTenantView>;
  list(): Promise<PlatformTenantView[]>;
  get(id: string): Promise<PlatformTenantView | null>;
  setEntitlements(id: string, document: unknown): Promise<PlatformTenantView | null>;
  setStatus(id: string, status: TenantStatus): Promise<PlatformTenantView | null>;
}

export interface PlatformDeps {
  token: string;
  store: PlatformStore;
  /** Set by `createApp` from its observability; a bare platform app logs and reports nothing. */
  log?: Logger | undefined;
  errors?: ErrorReporter | undefined;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

const CreateTenant = z
  .object({
    slug: z.string(),
    name: z.string().trim().min(1).max(200),
    locales: z.array(z.string().min(2).max(10)).min(1),
    defaultLocale: z.string().min(2).max(10).optional(),
    entitlements: EntitlementsDocument.optional(),
  })
  .strict();
const SetStatus = z.object({ status: TenantStatus }).strict();
const Id = z.string().uuid();

async function json(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new UseCaseError('invalid_input', 'body must be JSON', [
      { path: '', message: 'body must be JSON' },
    ]);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new UseCaseError(
      'invalid_input',
      'body does not match the schema',
      zodIssues(parsed.error)
    );
  return parsed.data;
}

const found = <T>(value: T | null): T => {
  if (value === null) throw new UseCaseError('not_found', 'no tenant with that id');
  return value;
};

export function createPlatformApp({ token, store, log = noopLogger, errors }: PlatformDeps): Hono {
  const expected = digest(token);
  const app = new Hono();

  app.use('*', async (c, next) => {
    const presented = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '')?.[1];
    if (!presented || !timingSafeEqual(digest(presented), expected))
      return problem('unauthorized', 'send Authorization: Bearer <platform token>', [], {
        'www-authenticate': 'Bearer',
      });
    await next();
  });

  app.post('/tenants', async (c) => {
    const input = parse(CreateTenant, await json(c.req));
    const tenant = await store.create(input);
    log.info('platform: tenant created', {
      tenantId: tenant.id,
      slug: tenant.slug,
      entitlements: JSON.stringify(tenant.storedEntitlements),
    });
    return c.json(tenant, 201);
  });

  app.get('/tenants', async (c) => c.json({ tenants: await store.list() }));

  app.get('/tenants/:id', async (c) =>
    c.json(found(await store.get(parse(Id, c.req.param('id')))))
  );

  app.put('/tenants/:id/entitlements', async (c) => {
    const id = parse(Id, c.req.param('id'));
    const tenant = found(await store.setEntitlements(id, await json(c.req)));
    log.info('platform: entitlements set', {
      tenantId: id,
      entitlements: JSON.stringify(tenant.storedEntitlements),
    });
    return c.json(tenant);
  });

  app.put('/tenants/:id/status', async (c) => {
    const id = parse(Id, c.req.param('id'));
    const { status } = parse(SetStatus, await json(c.req));
    const tenant = found(await store.setStatus(id, status));
    log.info('platform: status set', { tenantId: id, status });
    return c.json(tenant);
  });

  app.notFound(() => problem('not_found', 'no such platform route'));
  app.onError((err) => {
    if (err instanceof UseCaseError) return problem(err.code, err.message, err.issues);
    errors?.capture(err);
    return problem('internal');
  });
  return app;
}
