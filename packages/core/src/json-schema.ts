// JSON Schema for use-case inputs and outputs: the one conversion every front uses (ADR 009 rule
// 5). The OpenAPI document, the HTTP query-parameter list, the MCP tool schemas and the registry
// rules all call this, so "the OpenAPI request schema equals the MCP input schema" holds by
// construction. Rejected: a converter per front (they drift on options like union strictness),
// and a hand-written Zod walker (zod-to-json-schema already covers effects, records and unions,
// and the MCP SDK depends on it). Pure and I/O-free, so it may live in core (ADR 001).

import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export type JsonSchema = { [key: string]: unknown };

/**
 * `io` picks the side of a transform or pipe: requests are described as the caller sends them,
 * responses as the use case returns them. Refinements describe their inner schema (they still
 * run in the Invoker). References are inlined so each schema stands alone inside OpenAPI and MCP.
 */
export function toJsonSchema(schema: z.ZodTypeAny, io: 'input' | 'output'): JsonSchema {
  const converted = zodToJsonSchema(schema, {
    target: 'jsonSchema2019-09',
    $refStrategy: 'none',
    effectStrategy: 'input',
    pipeStrategy: io,
    strictUnions: true,
  }) as JsonSchema;
  delete converted.$schema;
  return converted;
}

/** True for `{ type: 'object' }` and for a union whose every member is one. */
export function describesObject(schema: JsonSchema): boolean {
  if (schema.type === 'object') return true;
  const members = schema.anyOf ?? schema.oneOf;
  return (
    Array.isArray(members) &&
    members.length > 0 &&
    members.every((m) => describesObject(m as JsonSchema))
  );
}
