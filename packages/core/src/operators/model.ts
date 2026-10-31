// Operators, their memberships of tenants, and API keys (TODO #7, ADR 002 rules 3 and 4). An
// operator is platform data: one person, identified by the IdP's `(issuer, subject)` once they
// have logged in, or by an address alone while an invitation waits. What they may do is decided
// per tenant by a membership; an API key belongs to one tenant and carries its own capabilities.
//
// Tokens are `mycel_` plus 32 random bytes in base64url. Only their SHA-256 is stored: with 256
// bits of entropy the hash is an unguessable lookup key, so a salt or a slow hash (argon2) would
// add cost without adding safety. Rejected: a key id inside the token, which would give a lookup
// that still needs the secret compared in constant time and a format to keep stable.

import { z } from 'zod';
import { Actor, Capability } from '../principal.js';
import { sha256Hex } from '../util/digest.js';
import { normalizeEmail } from '../util/email.js';
import { randomToken } from '../util/token.js';
import { Role, roleFor } from './roles.js';

export const Email = z.preprocess(
  (v) => (typeof v === 'string' ? normalizeEmail(v) : v),
  z.string().email().max(320)
);

/** Agents and integrations never manage members or keys: a key never carries `tenant:admin`. */
export const KeyCapability = Capability.exclude(['tenant:admin']);
export type KeyCapability = z.infer<typeof KeyCapability>;

/** A non-empty set without duplicates, so a stored list is never a surprise to read back. */
const capabilitySet = <T extends z.ZodTypeAny>(item: T) =>
  z
    .array(item)
    .min(1)
    .refine((list) => new Set(list).size === list.length, 'capabilities must not repeat');

export const Capabilities = capabilitySet(Capability);
export const KeyCapabilities = capabilitySet(KeyCapability);

export const Operator = z.object({
  id: z.string().guid(),
  email: z.string().email(),
  name: z.string().nullable(),
  emailVerifiedAt: z.string().datetime().nullable(),
  lastLoginAt: z.string().datetime().nullable(),
});
export type Operator = z.infer<typeof Operator>;

/** A row of the member list of one tenant. `pending`: the operator has never logged in. */
export const Member = z.object({
  operatorId: z.string().guid(),
  email: z.string().email(),
  name: z.string().nullable(),
  capabilities: z.array(Capability),
  pending: z.boolean(),
});
export type Member = z.infer<typeof Member>;

/** What the key list shows. Never the hash, never the token. */
export const ApiKeySummary = z.object({
  id: z.string().guid(),
  name: z.string(),
  prefix: z.string(),
  capabilities: z.array(KeyCapability),
  createdBy: Actor,
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});
export type ApiKeySummary = z.infer<typeof ApiKeySummary>;

/**
 * What the use cases return: the stored set plus the role it amounts to (#101), so HTTP, MCP and
 * the admin name the same role. Additive: the capabilities stay in the output and stay the truth.
 */
export const MemberView = Member.extend({ role: Role });
export type MemberView = z.infer<typeof MemberView>;
export const ApiKeyView = ApiKeySummary.extend({ role: Role });
export type ApiKeyView = z.infer<typeof ApiKeyView>;

export const withRole = <T extends { capabilities: readonly Capability[] }>(row: T) => ({
  ...row,
  role: roleFor(row.capabilities),
});

export const TOKEN_PREFIX = 'mycel_';
export const TOKEN_PATTERN = /^mycel_[A-Za-z0-9_-]{43}$/;
/** Characters of the token kept in clear, enough to recognise a key in a list. */
export const PREFIX_LENGTH = 12;

export interface GeneratedKey {
  token: string;
  prefix: string;
  hash: string;
}

/** A fresh token, its display prefix and its storage hash. */
export async function generateApiKey(): Promise<GeneratedKey> {
  const token = TOKEN_PREFIX + randomToken(32);
  return { token, prefix: token.slice(0, PREFIX_LENGTH), hash: await hashApiKey(token) };
}

export const hashApiKey = (token: string): Promise<string> => sha256Hex(token);
