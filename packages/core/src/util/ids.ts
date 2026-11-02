// The id schema and the example ids every use case shares. Ids are UUIDv7 in
// practice, but the schema accepts any RFC 9562 shape (`guid`), as every module already did
// inline; the examples are recognisable `01900000-…` values so a reader of OpenAPI or a log sees
// at once that an id is made up. Rejected: one constant per module, which had drifted to four
// copies of the same literal and thirty hand-typed ones.

import { z } from 'zod';

export const Uuid = z.string().guid();

/**
 * Whether a route segment or query value is an id in its one spelling: lowercase, as ids are
 * stored and linked. Stricter than `Uuid` on purpose, so one thing has one address and a storage
 * key built from it cannot differ by case.
 */
export const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/** The made-up id number `n` (hex digits in the last group), e.g. `exampleId(0xd001)`. */
export const exampleId = (n: number): string =>
  `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
