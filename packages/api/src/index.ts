// HTTP front (ADR 001, ADR 009). Routes are generated from the core registry; this file only
// composes the app. Hono over Express/Fastify: Web-standard Request/Response, tiny, portable.

import { Hono } from 'hono';
import { UseCaseRegistry } from '@mycel/core';

export function createApp(registry: UseCaseRegistry = new UseCaseRegistry()): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  // Every registered use case becomes POST /v1/<name> with the registry's input/output schemas.
  // Authentication middleware that builds the Principal lands with the first real use case.
  app.get('/v1', (c) =>
    c.json({
      operations: registry.list().map(({ name, kind, description, requires }) => ({
        name,
        kind,
        description,
        requires,
      })),
    })
  );

  return app;
}
