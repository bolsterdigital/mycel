// HTTP front (ADR 001, ADR 009). Every registered use case is `POST /v1/<name>` with a JSON body
// validated by the use case's own schema; a flat query is also `GET /v1/<name>?field=...` with a
// weak ETag (see `http-shape.ts`). Errors are Problem Details (`problem.ts`) and the OpenAPI 3.1
// document at `/openapi.json` is generated from the same registry (`openapi.ts`). Nothing here
// names a use case. Hono over Express/Fastify: Web-standard Request/Response, tiny, portable.
//
// Every request runs in a log context with a request id (TODO #17a): one access line per request
// with the route pattern, never the full path or query; `/readyz` and `/metrics` next to
// `/healthz`, which stays a pure liveness probe so a slow database never restarts the container.
//
// Every response, including 404s and problems, carries the API's security headers from the same
// middleware (TODO #20c decision 3): the API serves no HTML, so its CSP forbids everything.
// Rejected: `hono/secure-headers`, a dependency for five lines whose defaults differ from the
// web app's (apps/web/src/lib/server/security-headers.ts).

import { createHash, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { routePath } from 'hono/route';
import {
  MAX_UPLOAD_BYTES,
  UseCaseError,
  noopLogger,
  type ErrorReporter,
  type Invoker,
  type Logger,
  type Principal,
} from '@mycel/core';
import {
  METRICS_CONTENT_TYPE,
  Metrics,
  requestIdFrom,
  runWithContext,
  setContext,
} from '@mycel/observability';
import { createContentReadApp, type ContentReadDeps } from './content-read.js';
import { coerceQuery, flatQueryFields, methodsOf } from './http-shape.js';
import { openApiDocument } from './openapi.js';
import { bearerMatches } from './bearer.js';
import { createPlatformApp, type PlatformDeps } from './platform.js';
import { problem } from './problem.js';

export interface AppDeps {
  invoker: Invoker;
  authenticate(authorization: string | undefined): Promise<Principal | null>;
  /** The platform API (TODO #16); absent without PLATFORM_API_TOKEN, and `/platform/*` is a 404. */
  platform?: PlatformDeps | undefined;
  /** The public read route (ADR 012 rule 7, content-read.ts); without it `/v1/sites/*` is a 404. */
  contentRead?: ContentReadDeps | undefined;
  /** Logs, error reports, metrics and readiness; tests leave it out and get silence. */
  observability?: Partial<HttpObservability> | undefined;
  /** MYCEL_TRUST_PROXY=1: the scheme a request came over is the proxy's X-Forwarded-Proto. */
  trustProxy?: boolean | undefined;
}

export const API_SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
} as const;

/** The same HSTS as the web app: only over HTTPS, no includeSubDomains, no preload. */
export const API_HSTS = 'max-age=31536000';

export interface HttpObservability {
  log: Logger;
  errors: ErrorReporter;
  metrics: Metrics;
  /** A fresh request id when the incoming `X-Request-Id` is absent or malformed. */
  newRequestId(): string;
  /** `select 1` over the application connection, with a time-out. */
  ready(): Promise<boolean>;
  /** Bearer token for `/metrics`; without it the route is a 404. */
  metricsToken: string | undefined;
}

const silent: HttpObservability = {
  log: noopLogger,
  errors: { capture() {} },
  metrics: new Metrics(),
  newRequestId: randomUUID,
  ready: async () => false,
  metricsToken: undefined,
};

const statusClass = (status: number) => `${Math.floor(status / 100)}xx`;

/**
 * The largest JSON body any use case takes: a base64 upload of `MAX_UPLOAD_BYTES` (a third
 * larger) plus room for its other fields. One limit for every route, so no route names a use
 * case; the use case's own schema refuses what is too large inside that (`invalid_input`).
 */
export const MAX_BODY_BYTES = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 1024 * 1024;

const unauthorized = () =>
  problem('unauthorized', 'send Authorization: Bearer <api key>', [], {
    'www-authenticate': 'Bearer',
  });

/** Weak, because the hash covers the JSON serialisation, not a byte-exact representation. */
const etagOf = (body: string) =>
  `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;

function matches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  return ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === opaque(etag));
}

export function createApp({
  invoker,
  authenticate,
  platform,
  contentRead,
  observability,
  trustProxy = false,
}: AppDeps): Hono {
  const app = new Hono();
  const { registry } = invoker;
  const openapi = openApiDocument(registry);
  const obs = { ...silent, ...observability };
  const requests = obs.metrics.counter(
    'mycel_http_requests_total',
    'HTTP requests by method, route pattern and status class'
  );
  const useCaseErrors = obs.metrics.counter(
    'mycel_use_case_errors_total',
    'Use case refusals by error code'
  );

  app.use('*', async (c, next) => {
    const requestId = requestIdFrom(c.req.header('x-request-id'), obs.newRequestId);
    const started = performance.now();
    await runWithContext({ requestId }, async () => {
      await next();
      c.res.headers.set('x-request-id', requestId);
      for (const [name, value] of Object.entries(API_SECURITY_HEADERS))
        if (!c.res.headers.has(name)) c.res.headers.set(name, value);
      const scheme = trustProxy
        ? (c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.slice(0, -1))
        : new URL(c.req.url).protocol.slice(0, -1);
      if (scheme === 'https') c.res.headers.set('strict-transport-security', API_HSTS);
      // The last matched route is the handler's pattern; only middleware matched means 404.
      const route = routePath(c, -1);
      const status = c.res.status;
      requests.inc({ method: c.req.method, route, status: statusClass(status) });
      // Probes every few seconds would drown the log; they stay visible at debug.
      const probe = route === '/healthz' || route === '/readyz' || route === '/metrics';
      obs.log[probe ? 'debug' : 'info']('request', {
        method: c.req.method,
        route,
        status,
        durationMs: Math.round(performance.now() - started),
      });
    });
  });

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) =>
    (await obs.ready()) ? c.json({ db: 'ok' }) : c.json({ db: 'down' }, 503)
  );
  app.get('/metrics', (c) => {
    if (!bearerMatches(c.req.header('authorization'), obs.metricsToken)) return c.notFound();
    return c.body(obs.metrics.render(), 200, { 'content-type': METRICS_CONTENT_TYPE });
  });
  app.get('/openapi.json', (c) => c.json(openapi));

  app.get('/v1', (c) =>
    c.json({
      operations: registry.list().map((useCase) => ({
        name: useCase.name,
        kind: useCase.kind,
        description: useCase.description,
        requires: useCase.requires,
        ...(useCase.effect ? { effect: useCase.effect } : {}),
        methods: methodsOf(useCase),
      })),
    })
  );

  if (platform)
    app.route('/platform', createPlatformApp({ ...platform, log: obs.log, errors: obs.errors }));
  if (contentRead) app.route('/v1/sites', createContentReadApp(contentRead));

  const principalOf = async (c: Context) => {
    const principal = await authenticate(c.req.header('authorization'));
    if (principal) setContext({ tenantId: principal.tenantId });
    return principal;
  };

  app.post(
    '/v1/:name',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () =>
        problem('payload_too_large', `the body is larger than ${MAX_BODY_BYTES} bytes`),
    })
  );
  app.post('/v1/:name', async (c) => {
    const principal = await principalOf(c);
    if (!principal) return unauthorized();
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return problem('invalid_input', 'body must be JSON', [
        { path: '', message: 'body must be JSON' },
      ]);
    }
    return c.json(await invoker.call(principal, c.req.param('name'), body));
  });

  app.get('/v1/:name', async (c) => {
    const useCase = registry.get(c.req.param('name'));
    const fields = useCase && flatQueryFields(useCase);
    if (useCase && !fields)
      return problem('method_not_allowed', `${useCase.name} is POST only`, [], { allow: 'POST' });
    const principal = await principalOf(c);
    if (!principal) return unauthorized();
    if (!useCase || !fields)
      throw new UseCaseError('not_found', `unknown operation "${c.req.param('name')}"`);

    const body = JSON.stringify(
      await invoker.run(useCase, principal, coerceQuery(fields, c.req.queries()))
    );
    const etag = etagOf(body);
    // Responses depend on the caller, so only the caller's own cache may keep them.
    const headers = { etag, 'cache-control': 'private, no-cache', vary: 'Authorization' };
    if (matches(c.req.header('if-none-match'), etag))
      return new Response(null, { status: 304, headers });
    return new Response(body, { headers: { ...headers, 'content-type': 'application/json' } });
  });

  app.onError((err) => {
    if (err instanceof UseCaseError) {
      useCaseErrors.inc({ code: err.code });
      return problem(err.code, err.message, err.issues);
    }
    obs.errors.capture(err);
    return problem('internal');
  });

  return app;
}
