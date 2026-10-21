// Registry conformance for the HTTP front (testing.md): generic over `buildRegistry().list()`, so
// a new use case is covered without touching this file. Domain behaviour lives in app.test.ts.

import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';
import {
  Invoker,
  buildRegistry,
  toJsonSchema,
  type Capability,
  type Principal,
  type UseCase,
} from '@mycel/core';
import { MemoryUnitOfWork } from '@mycel/core/testing';
import { createApp } from './app.js';
import { flatQueryFields } from './http-shape.js';
import { openApiDocument } from './openapi.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const registry = buildRegistry();
const useCases = registry.list();

const principal = (capabilities: Capability[]): Principal => ({
  tenantId: TENANT,
  actor: { kind: 'api-key', keyId: 'conformance' },
  capabilities,
});

// Bearer tokens name the capabilities, so each request picks its own principal.
const app = createApp({
  invoker: new Invoker(registry, new MemoryUnitOfWork()),
  authenticate: async (header) => {
    const caps = header?.match(/^Bearer caps:(.*)$/)?.[1];
    return caps === undefined ? null : principal(caps ? (caps.split(',') as Capability[]) : []);
  },
});

const post = (useCase: UseCase, body: string, auth?: string) =>
  app.request(`/v1/${useCase.name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body,
  });

const exactly = (useCase: UseCase) => `Bearer caps:${useCase.requires}`;

/** A body that fails every object schema: the wrong top-level type. */
const SCHEMA_VIOLATION = '[]';

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toBe('application/problem+json');
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ type: `urn:mycel:problem:${code}`, status, code });
  expect(typeof body.title).toBe('string');
  return body;
}

describe.each(useCases.map((u) => [u.name, u] as const))('HTTP conformance: %s', (_n, useCase) => {
  const example = JSON.stringify(useCase.examples[0].input);

  it('401 without credentials', async () => {
    await expectProblem(await post(useCase, example), 401, 'unauthorized');
  });

  it('403 for a principal without the capability', async () => {
    await expectProblem(await post(useCase, example, 'Bearer caps:'), 403, 'forbidden');
  });

  it('400 Problem Details with issues for a schema violation and for a non-JSON body', async () => {
    for (const body of [SCHEMA_VIOLATION, '{not json']) {
      const problem = await expectProblem(
        await post(useCase, body, exactly(useCase)),
        400,
        'invalid_input'
      );
      expect(Array.isArray(problem.issues) && problem.issues.length > 0).toBe(true);
    }
  });

  it('accepts examples[0] with exactly the required capability', async () => {
    const res = await post(useCase, example, exactly(useCase));
    // The example's data need not exist in an empty tenant: 404 and 409 are fine, rejection is not.
    expect([200, 404, 409]).toContain(res.status);
  });

  it('serves GET exactly when the input is a flat query', async () => {
    const res = await app.request(`/v1/${useCase.name}`, {
      headers: { authorization: exactly(useCase) },
    });
    if (flatQueryFields(useCase)) expect(res.status).not.toBe(405);
    else await expectProblem(res, 405, 'method_not_allowed');
  });
});

describe('OpenAPI document', () => {
  const doc = openApiDocument(registry) as {
    paths: Record<string, Record<string, { operationId: string; requestBody?: any }>>;
  };

  it('is served without credentials and validates as OpenAPI 3.1', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const served = await res.json();
    expect(served).toEqual(doc);
    await expect(SwaggerParser.validate(structuredClone(served))).resolves.toBeTruthy();
  });

  it('has one operation per use case per method, and nothing else', () => {
    const operations = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, op]) => `${method} ${path} ${op.operationId}`)
    );
    const expected = useCases.flatMap((u) =>
      flatQueryFields(u)
        ? [`get /v1/${u.name} ${u.name}`, `post /v1/${u.name} ${u.name}.post`]
        : [`post /v1/${u.name} ${u.name}`]
    );
    expect(operations.sort()).toEqual(expected.sort());
  });

  it("describes every request body with the use case's input schema", () => {
    for (const u of useCases)
      for (const op of Object.values(doc.paths[`/v1/${u.name}`]!))
        if (op.requestBody)
          expect(op.requestBody.content['application/json'].schema).toEqual(
            toJsonSchema(u.input, 'input')
          );
  });
});
