// How a use case maps onto HTTP methods (brief registry-http-mcp, decision 3). Every use case is
// `POST /v1/<name>`; a query whose input is a flat object of scalars is also `GET` with query
// parameters, so it can be cached and revalidated. Shared by the router and the OpenAPI
// generator so the document can never list a GET the router does not serve.

import { z } from 'zod';
import type { UseCase } from '@mycel/core';

export type ScalarType = 'string' | 'number' | 'boolean';
export type FlatFields = Record<string, { type: ScalarType; required: boolean }>;

function scalarType(schema: z.ZodTypeAny): ScalarType | null {
  if (schema instanceof z.ZodString || schema instanceof z.ZodEnum) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  return null;
}

/** The fields of a flat query's input, or null when the use case is POST-only. */
export function flatQueryFields(useCase: UseCase): FlatFields | null {
  if (useCase.kind !== 'query') return null;
  let input: z.ZodTypeAny = useCase.input;
  while (input instanceof z.ZodEffects) input = input.innerType();
  if (!(input instanceof z.ZodObject)) return null;
  const fields: FlatFields = {};
  for (const [name, field] of Object.entries(input.shape as z.ZodRawShape)) {
    const optional = field instanceof z.ZodOptional;
    const type = scalarType(optional ? field.unwrap() : field);
    if (!type) return null;
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
