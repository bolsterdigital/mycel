// OpenAPI 3.1 document generated from the registry (ADR 009 rule 5): one operation per use case
// per method, schemas from core's `toJsonSchema`, so the document, the router and the MCP tools
// describe the same thing. Rejected: `@hono/zod-openapi`, which wants a route definition per use
// case, exactly what the registry makes unnecessary; and a hand-written document, which drifts.
//
// One path is written by hand: the public read route (content-read.ts, ADR 012 rule 7), which is
// not a use-case route. Its response schema is still the use case's output, so it cannot drift.

import {
  toJsonSchema,
  useCases,
  type JsonSchema,
  type UseCase,
  type UseCaseRegistry,
} from '@mycel/core';
import { buildVersion } from '@mycel/observability';
import { CONTENT_READ_PATH } from './content-read.js';
import { flatQueryFields } from './http-shape.js';
import { PROBLEMS, problemType, type ProblemCode } from './problem.js';

const problemRef = { $ref: '#/components/responses/Problem' };
const ERROR_STATUSES = ['400', '401', '403', '404', '409', '500'];

function operation(
  useCase: UseCase,
  method: 'get' | 'post',
  operationId: string,
  input: JsonSchema
): Record<string, unknown> {
  const isGet = method === 'get';
  const properties = (input.properties ?? {}) as Record<string, JsonSchema>;
  const required = (input.required ?? []) as string[];
  const ok: Record<string, unknown> = {
    description: 'The use case result.',
    content: { 'application/json': { schema: toJsonSchema(useCase.output, 'output') } },
  };
  if (isGet) ok.headers = { ETag: { schema: { type: 'string' } } };
  return {
    operationId,
    summary: useCase.description,
    tags: [useCase.name.split('.')[0]],
    security: [{ bearerAuth: [] }],
    ...(isGet
      ? {
          parameters: Object.entries(properties).map(([name, schema]) => ({
            name,
            in: 'query',
            required: required.includes(name),
            schema,
          })),
        }
      : { requestBody: { required: true, content: { 'application/json': { schema: input } } } }),
    responses: {
      '200': ok,
      ...(isGet ? { '304': { description: 'Not modified (If-None-Match matched).' } } : {}),
      ...Object.fromEntries(ERROR_STATUSES.map((status) => [status, problemRef])),
    },
    'x-mycel-kind': useCase.kind,
    'x-mycel-requires': useCase.requires,
    ...(useCase.effect ? { 'x-mycel-effect': useCase.effect } : {}),
  };
}

function contentReadOperation(): Record<string, unknown> {
  const param = (name: string, schema: JsonSchema, required = true, where = 'path') => ({
    name,
    in: where,
    required,
    schema,
  });
  const slug = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' };
  return {
    operationId: 'sites.content.read',
    summary:
      'Published content of a site as JSON, without an API key: one published locale of a public page or article. Cached publicly with a strong ETag.',
    tags: ['content'],
    security: [],
    parameters: [
      param('tenant', slug),
      param('type', { type: 'string', enum: ['page', 'article'] }),
      param('slug', slug),
      param('locale', { type: 'string', pattern: '^[a-z]{2,3}(-[A-Z]{2})?$' }, false, 'query'),
    ],
    responses: {
      '200': {
        description: 'The published item.',
        headers: {
          ETag: { schema: { type: 'string' } },
          'Cache-Control': { schema: { type: 'string' } },
        },
        content: {
          'application/json': { schema: toJsonSchema(useCases.getPublished.output, 'output') },
        },
      },
      '304': { description: 'Not modified (If-None-Match matched).' },
      '400': problemRef,
      '404': problemRef,
      '500': problemRef,
    },
  };
}

export function openApiDocument(registry: UseCaseRegistry): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const useCase of registry.list()) {
    const input = toJsonSchema(useCase.input, 'input');
    // The canonical method carries the plain name as operationId; a flat query's POST is `.post`.
    paths[`/v1/${useCase.name}`] = flatQueryFields(useCase)
      ? {
          get: operation(useCase, 'get', useCase.name, input),
          post: operation(useCase, 'post', `${useCase.name}.post`, input),
        }
      : { post: operation(useCase, 'post', useCase.name, input) };
  }
  paths[CONTENT_READ_PATH] = { get: contentReadOperation() };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Mycel API',
      version: buildVersion(),
      description: 'Generated from the use-case registry; the MCP server exposes the same set.',
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      responses: {
        Problem: {
          description: 'Problem Details (RFC 9457).',
          content: {
            'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
          },
        },
      },
      schemas: {
        Problem: {
          type: 'object',
          required: ['type', 'title', 'status', 'code'],
          properties: {
            type: {
              type: 'string',
              enum: (Object.keys(PROBLEMS) as ProblemCode[]).map(problemType),
            },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            code: { type: 'string', enum: Object.keys(PROBLEMS) },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                required: ['path', 'message'],
                properties: { path: { type: 'string' }, message: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  };
}
