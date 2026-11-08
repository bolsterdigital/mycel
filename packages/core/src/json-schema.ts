// JSON Schema for use-case inputs and outputs: the one conversion every front uses (ADR 009 rule
// 5). The OpenAPI document, the HTTP query-parameter list, the MCP tool schemas and the registry
// rules all call this, so "the OpenAPI request schema equals the MCP input schema" holds by
// construction. Rejected: a converter per front (they drift on options like union strictness),
// and a hand-written Zod walker. Zod 4 owns the conversion alongside its validators; the old
// zod-to-json-schema converter only understands Zod 3. Pure and I/O-free (ADR 001).

import { z } from 'zod';

export type JsonSchema = { [key: string]: unknown };

/**
 * `io` picks the side of a transform or pipe: requests are described as the caller sends them,
 * responses as the use case returns them. Refinements describe their inner schema (they still
 * run in the Invoker). By default references are inlined, because a `#/$defs` reference inside an
 * OpenAPI component resolves against the OpenAPI document, not the schema. `reused: 'ref'` moves
 * every schema used more than once into the schema's own `$defs`: still self-contained, for fronts
 * that take each schema as its own document (MCP tools), where inlining the rich-text schema at
 * every block field made one content tool 384 KB and the listing 6.5 MB.
 */
export function toJsonSchema(
  schema: z.ZodTypeAny,
  io: 'input' | 'output',
  { reused = 'inline' }: { reused?: 'inline' | 'ref' } = {}
): JsonSchema {
  const converted = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    reused,
    cycles: 'throw',
    // Zod 3's uuid() accepted any GUID; keep that validation and its public format label.
    override: ({ zodSchema, jsonSchema }) => {
      if (jsonSchema.format === 'guid') jsonSchema.format = 'uuid';
      // Strip-mode objects still advertise a closed wire vocabulary, as before the upgrade.
      if (zodSchema._zod.def.type === 'object' && !zodSchema._zod.def.catchall)
        jsonSchema.additionalProperties = false;
    },
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
