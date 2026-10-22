// The audit log (TODO #17b, brief observability-b-audit): one row per command, who did what and
// how it ended. A row names its actor by id and its input by a keyed hash, never by content: audit
// is who-did-what, not a copy of the data (ADR 019 rule 8). `platform` is the hoster's platform
// API and CLI, which run under no principal and write their rows themselves (packages/db).

import { z } from 'zod';
import { UseCaseError } from '../errors.js';
import type { Actor } from '../principal.js';
import { canonicalJson } from '../util/canonical-json.js';
import type { InputHasher } from './ports.js';

export const AuditActorKind = z.enum([
  'operator',
  'api-key',
  'agent',
  'system',
  'anonymous',
  'platform',
]);
export type AuditActorKind = z.infer<typeof AuditActorKind>;

/** `ok`, a `UseCaseError` code (`forbidden`, `invalid_input`, `suspended`, ...) or `error`. */
export type AuditResult = string;

export interface AuditEntry {
  id: string;
  /** Null only for a platform action without a tenant; a command always has one. */
  tenantId: string | null;
  occurredAt: Date;
  actorKind: AuditActorKind;
  actorId: string | null;
  /** The use-case name, or `platform.<action>`. */
  operation: string;
  /** The ADR 018 effect of the command, when it has one. */
  effect: string | null;
  /** Hex HMAC-SHA256 of the canonical input (`hashInput`). */
  inputHash: string;
  result: AuditResult;
  requestId: string | null;
  /** The id of the object the command touched, when its output has one. */
  subjectId: string | null;
}

/**
 * Kind and id of an actor, ids only: an operator is its operator id, never its address; an agent
 * is the key it acts with; an anonymous visitor has no id (and no `ipHash` in the audit).
 */
export function auditActor(actor: Actor): { kind: AuditActorKind; id: string | null } {
  switch (actor.kind) {
    case 'operator':
      return { kind: 'operator', id: actor.operatorId };
    case 'api-key':
      return { kind: 'api-key', id: actor.keyId };
    case 'agent':
      return { kind: 'agent', id: actor.keyId };
    case 'system':
      return { kind: 'system', id: actor.job };
    case 'anonymous':
      return { kind: 'anonymous', id: null };
  }
}

/** The result column for a failure: the `UseCaseError` code, anything else is `error`. */
export function auditResult(error: unknown): AuditResult {
  return error instanceof UseCaseError ? error.code : 'error';
}

/** The output's `id`, when it is an object with a string id. */
export function auditSubject(output: unknown): string | null {
  const id = (output as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : null;
}

/**
 * The keyed hash of an input: HMAC over its canonical JSON. An input that cannot be serialised (a
 * cycle, a bigint) hashes as a fixed marker; only an unparsed input can be one.
 */
export async function hashInput(hasher: InputHasher, input: unknown): Promise<string> {
  let canonical: string;
  try {
    canonical = canonicalJson(input);
  } catch {
    canonical = '"<unserialisable>"';
  }
  return hasher.hash(canonical);
}
