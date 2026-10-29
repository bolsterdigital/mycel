// The platform API (ADR 015 rule 4, ADR 002 rule 4, TODO #16): how a hoster's billing system
// (for Bureau Bolster: the client portal) creates tenants and sets their entitlements and status.
// Mounted at `/platform/*` in the same Hono app, but outside the registry: these operations run
// under no tenant, so they are not use cases, not MCP tools and not in `/openapi.json` (that
// document describes the tenant API). They run as the `mycel_platform` role, entered from the
// authentication login; the API never holds the schema owner's credentials (ADR 011 rule 1).
// Their shape is in docs/reference/platform-api.md; the functions behind them are
// packages/db/src/platform.ts, which `npm run platform` calls too.
//
// One bearer token, PLATFORM_API_TOKEN, compared by `bearerMatches` (constant time over SHA-256
// digests). Without the variable the routes do not exist: a self-hoster manages tenants with the
// CLI. Every mutation writes its audit row in its own transaction
// (packages/db/src/platform.ts, TODO #17b); the server log keeps one operational line. Rejected:
// a `platform:admin` capability on an API key (keys are tenant data under forced RLS).

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
import type { Metrics } from '@mycel/observability';
import { bearerMatches } from './bearer.js';
import { problemOnError, readJson, unauthorized } from './http-shape.js';
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
  /** Stuck work across tenants, read as mycel_ops (TODO #17c, migration 0016). */
  ops: PlatformOpsStore;
}

export interface OpsQuery {
  tenantId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** A page of stuck rows; the shapes are packages/db/src/recovery.ts's, never a payload. */
export interface OpsPage {
  items: unknown[];
  nextCursor: string | null;
}

/** `ok`, or why nothing changed: unknown id, or a row that is not stuck (`conflict`). */
export type OpsRecovery = 'ok' | 'not_found' | 'not_exhausted';

export interface PlatformOpsStore {
  summary(): Promise<unknown[]>;
  jobs(query: OpsQuery): Promise<OpsPage>;
  outbox(query: OpsQuery): Promise<OpsPage>;
  mail(query: OpsQuery): Promise<OpsPage>;
  /** The tenant recoveries' rules (`ops.job.retry|close`), for any tenant; each writes its audit row. */
  retryJob(id: string): Promise<OpsRecovery>;
  closeJob(id: string): Promise<OpsRecovery>;
  /** New passes for a dead event; subscribers that delivered are not run again. */
  retryEvent(id: string): Promise<OpsRecovery>;
}

export interface PlatformDeps {
  token: string;
  store: PlatformStore;
  /** Set by `createApp` from its observability; a bare platform app logs and reports nothing. */
  log?: Logger | undefined;
  errors?: ErrorReporter | undefined;
  metrics?: Metrics | undefined;
}

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
const Id = z.string().guid();
const OpsQuery = z
  .object({
    tenantId: Id.optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

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

export function createPlatformApp({
  token,
  store,
  log = noopLogger,
  errors,
  metrics,
}: PlatformDeps): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    if (!bearerMatches(c.req.header('authorization'), token)) return unauthorized('platform token');
    await next();
  });

  app.post('/tenants', async (c) => {
    const input = parse(CreateTenant, await readJson(c.req));
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
    const tenant = found(await store.setEntitlements(id, await readJson(c.req)));
    log.info('platform: entitlements set', {
      tenantId: id,
      entitlements: JSON.stringify(tenant.storedEntitlements),
    });
    return c.json(tenant);
  });

  app.put('/tenants/:id/status', async (c) => {
    const id = parse(Id, c.req.param('id'));
    const { status } = parse(SetStatus, await readJson(c.req));
    const tenant = found(await store.setStatus(id, status));
    log.info('platform: status set', { tenantId: id, status });
    return c.json(tenant);
  });

  // Stuck work (TODO #17c): counts per tenant, then the rows, a page at a time; and the three
  // recoveries, as mycel_ops with the rules of the tenant's own (`ops.job.retry|close`). There is
  // no route that acts as a tenant's administrator: the hoster recovers as the platform, audited
  // as such.
  app.get('/ops/summary', async (c) => c.json({ tenants: await store.ops.summary() }));
  for (const [path, list] of [
    ['jobs', (q: OpsQuery) => store.ops.jobs(q)],
    ['outbox', (q: OpsQuery) => store.ops.outbox(q)],
    ['mail', (q: OpsQuery) => store.ops.mail(q)],
  ] as const)
    app.get(`/ops/${path}`, async (c) => c.json(await list(parse(OpsQuery, c.req.query()))));
  for (const [path, recover] of [
    ['jobs/:id/retry', (id: string) => store.ops.retryJob(id)],
    ['jobs/:id/close', (id: string) => store.ops.closeJob(id)],
    ['outbox/:id/retry', (id: string) => store.ops.retryEvent(id)],
  ] as const)
    app.post(`/ops/${path}`, async (c) => {
      const id = parse(Id, c.req.param('id'));
      const result = await recover(id);
      if (result === 'not_found') throw new UseCaseError('not_found', 'no stuck row with that id');
      if (result === 'not_exhausted')
        throw new UseCaseError(
          'conflict',
          'not stuck: it has attempts left, is running right now, or is already done'
        );
      log.info('platform: recovered', { path, id });
      return c.json({ id });
    });

  app.notFound(() => problem('not_found', 'no such platform route'));
  app.onError(problemOnError({ metrics, errors }));
  return app;
}
