// How a use case maps onto HTTP methods (brief registry-http-mcp, decision 3). Every use case is
// `POST /v1/<name>`; a query whose input is a flat object of scalars is also `GET` with query
// parameters, so it can be cached and revalidated. A query keyed by an e-mail address stays POST
// only: a GET would put the address in access logs, proxies and browser history (TODO #17 says
// logs never hold one), and the stable supporter id of ADR 019 is the lookup meant for GET.
// Rejected: a per-use-case opt-out, which a builder can forget. Shared by the router and the
// OpenAPI generator so the document can never list a GET the router does not serve.
//
// The HTTP edges every Hono app here shares live below as well (TODO #74 step 3): the ETag and
// its If-None-Match rule, the JSON body read, the 401 and the error handler. `app.ts`,
// `platform.ts` and `content-read.ts` each had their own copy, and the platform's handler did not
// count refusals. Rejected: a Hono middleware per edge, which hides from a route what it answers.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { UseCaseError, type ErrorReporter, type UseCase } from '@mycel/core';
import type { Metrics } from '@mycel/observability';
import { problem } from './problem.js';

export type ScalarType = 'string' | 'number' | 'boolean';
export type FlatFields = Record<string, { type: ScalarType; required: boolean }>;

function scalarType(schema: z.ZodTypeAny): ScalarType | null {
  if (schema instanceof z.ZodString || schema instanceof z.ZodEnum) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  return null;
}

/** True for a string validated with `.email()`: personal data that must not travel in a URL. */
export function isEmailField(schema: z.ZodTypeAny): boolean {
  return schema instanceof z.ZodString && z.toJSONSchema(schema).format === 'email';
}

/** The fields of a flat query's input, or null when the use case is POST-only. */
export function flatQueryFields(useCase: UseCase): FlatFields | null {
  if (useCase.kind !== 'query') return null;
  const input: z.ZodTypeAny = useCase.input;
  if (!(input instanceof z.ZodObject)) return null;
  const fields: FlatFields = {};
  for (const [name, field] of Object.entries(input.shape as Record<string, z.ZodTypeAny>)) {
    const optional = field instanceof z.ZodOptional;
    const inner: z.ZodTypeAny = optional ? (field.unwrap() as z.ZodTypeAny) : field;
    const type = scalarType(inner);
    if (!type || isEmailField(inner)) return null;
    fields[name] = { type, required: !optional };
  }
  return fields;
}

export function methodsOf(useCase: UseCase): ('GET' | 'POST')[] {
  return flatQueryFields(useCase) ? ['GET', 'POST'] : ['POST'];
}

/**
 * Query parameters are strings; turn them into what the schema expects. Values that do not
 * coerce are passed on unchanged so the schema reports them, and a repeated parameter stays an
 * array for the same reason.
 */
export function coerceQuery(fields: FlatFields, query: Record<string, string[]>): unknown {
  const input: Record<string, unknown> = {};
  for (const [name, { type }] of Object.entries(fields)) {
    const values = query[name];
    if (!values?.length) continue;
    if (values.length > 1) {
      input[name] = values;
      continue;
    }
    const raw = values[0]!;
    if (type === 'number' && raw.trim() !== '' && !Number.isNaN(Number(raw)))
      input[name] = Number(raw);
    else if (type === 'boolean' && (raw === 'true' || raw === 'false'))
      input[name] = raw === 'true';
    else input[name] = raw;
  }
  return input;
}

/**
 * An ETag over a serialised body. Without `key` it is weak (the hash covers the JSON
 * serialisation, not a byte-exact representation); with one, strong and prefixed by it, for a
 * representation that a key such as revision and locale already names.
 */
export function etag(body: string, key?: string): string {
  const digest = createHash('sha256').update(body).digest('base64url');
  return key === undefined ? `W/"${digest.slice(0, 27)}"` : `"${key}:${digest.slice(0, 16)}"`;
}

/** If-None-Match compares weakly (RFC 9110 § 13.1.2); `*` matches any current representation. */
function ifNoneMatch(header: string | undefined, tag: string): boolean {
  if (!header) return false;
  const opaque = (t: string) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => t.trim() === '*' || opaque(t) === opaque(tag));
}

/** The JSON body with its `etag` and caching headers, or a 304 when the client already holds it. */
export function conditionalJson(
  header: string | undefined,
  body: string,
  headers: { etag: string; [name: string]: string }
): Response {
  if (ifNoneMatch(header, headers.etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { headers: { ...headers, 'content-type': 'application/json' } });
}

/** The request body as JSON; `invalid_input` when it is not. */
export async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new UseCaseError('invalid_input', 'body must be JSON', [
      { path: '', message: 'body must be JSON' },
    ]);
  }
}

/** The 401 for a missing or wrong bearer; `credential` names what to send. */
export const unauthorized = (credential: string): Response =>
  problem('unauthorized', `send Authorization: Bearer <${credential}>`, [], {
    'www-authenticate': 'Bearer',
  });

/**
 * `app.onError`: a refusal is its Problem and counts in `mycel_use_case_errors_total`; anything
 * else is reported and a bare `internal`, so no stack or message reaches the client.
 */
export function problemOnError({
  metrics,
  errors,
}: {
  metrics?: Metrics | undefined;
  errors?: ErrorReporter | undefined;
}): (err: Error) => Response {
  const refusals = metrics?.counter(
    'mycel_use_case_errors_total',
    'Use case refusals by error code'
  );
  return (err) => {
    if (err instanceof UseCaseError) {
      refusals?.inc({ code: err.code });
      return problem(err.code, err.message, err.issues);
    }
    errors?.capture(err);
    return problem('internal');
  };
}
