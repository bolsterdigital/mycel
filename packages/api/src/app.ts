// HTTP front (ADR 001, ADR 009). Every registered use case is `POST /v1/<name>` with a JSON body
// validated by the use case's own schema; a flat query is also `GET /v1/<name>?field=...` with a
// weak ETag (see `http-shape.ts`). Errors are Problem Details (`problem.ts`) and the OpenAPI 3.1
// document at `/openapi.json` is generated from the same registry (`openapi.ts`). Nothing here
// names a use case. Hono over Express/Fastify: Web-standard Request/Response, tiny, portable.

import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { UseCaseError, type Invoker, type Principal } from '@mycel/core';
import { coerceQuery, flatQueryFields, methodsOf } from './http-shape.js';
import { openApiDocument } from './openapi.js';
import { createPlatformApp, type PlatformDeps } from './platform.js';
import { problem } from './problem.js';

export interface AppDeps {
  invoker: Invoker;
  authenticate(authorization: string | undefined): Promise<Principal | null>;
  /** The platform API (TODO #16); absent without PLATFORM_API_TOKEN, and `/platform/*` is a 404. */
  platform?: PlatformDeps | undefined;
}

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

export function createApp({ invoker, authenticate, platform }: AppDeps): Hono {
  const app = new Hono();
  const { registry } = invoker;
  const openapi = openApiDocument(registry);

  app.get('/healthz', (c) => c.json({ ok: true }));
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

  if (platform) app.route('/platform', createPlatformApp(platform));

  const principalOf = (c: Context) => authenticate(c.req.header('authorization'));

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
    if (err instanceof UseCaseError) return problem(err.code, err.message, err.issues);
    console.error(err);
    return problem('internal');
  });

  return app;
}
