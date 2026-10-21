// HTTP front (ADR 001, ADR 009). Every registered use case is `POST /v1/<name>` with a JSON body
// validated by the use case's own schema; errors are Problem Details (RFC 9457). The generic
// mapper is deliberately small: OpenAPI generation and per-kind HTTP semantics (GET for queries,
// ETags) are TODO #3. Hono over Express/Fastify: Web-standard Request/Response, tiny, portable.

import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { UseCaseError, type Invoker, type Principal, type UseCaseErrorCode } from '@mycel/core';

const STATUS: Record<UseCaseErrorCode, ContentfulStatusCode> = {
  not_found: 404,
  forbidden: 403,
  invalid_input: 422,
  conflict: 409,
};

function problem(
  status: ContentfulStatusCode,
  title: string,
  detail?: string,
  extra: object = {}
): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title, status, detail, ...extra }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

export interface AppDeps {
  invoker: Invoker;
  authenticate(authorization: string | undefined): Promise<Principal | null>;
}

export function createApp({ invoker, authenticate }: AppDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/v1', (c) =>
    c.json({
      operations: invoker.registry.list().map(({ name, kind, description, requires }) => ({
        name,
        kind,
        description,
        requires,
      })),
    })
  );

  app.post('/v1/:name', async (c) => {
    const principal = await authenticate(c.req.header('authorization'));
    if (!principal) return problem(401, 'Unauthorized', 'send Authorization: Bearer <api key>');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return problem(400, 'Bad Request', 'body must be JSON');
    }
    return c.json(await invoker.call(principal, c.req.param('name'), body));
  });

  app.onError((err) => {
    if (err instanceof UseCaseError)
      return problem(
        STATUS[err.code],
        err.code,
        err.message,
        err.issues.length ? { issues: err.issues } : {}
      );
    console.error(err);
    return problem(500, 'Internal Server Error');
  });

  return app;
}
