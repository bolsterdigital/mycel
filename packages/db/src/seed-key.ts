// The seed's API key: the token from MYCEL_API_KEY stored as key "seed" of the seeded tenant, so
// API and MCP work without clicking a key together first. The key is inserted once, on its hash,
// so a fixed token in a local .env keeps the capabilities of its first seed: a capability added to
// SEED_KEY_CAPABILITIES later never reaches it, and e2e then fails on a 403 that CI, with a fresh
// token every run, never shows. The seed therefore refuses with what is missing and how to fix it.
// Rejected: rewriting the stored capabilities in place, which widens a live key outside the
// use case that changes keys, without its audit row; the seed is not where key rights change.

import {
  PREFIX_LENGTH,
  hashApiKey,
  type KeyCapability,
  type Principal,
  type UnitOfWork,
} from '@mycel/core';
import { uuidv7 } from './ids.js';

/** What the seed key may do: content and form reads, supporter reads, content writes, media. */
export const SEED_KEY_CAPABILITIES: readonly KeyCapability[] = [
  'content:read',
  'forms:read',
  'supporters:read',
  'content:write',
  'media:read',
  'media:write',
];

/**
 * Store `token` as the "seed" key of the principal's tenant, or check the one stored before.
 * Throws when a stored key lacks a capability the seed grants, is revoked, or belongs elsewhere.
 */
export async function seedApiKey(
  uow: UnitOfWork,
  admin: Principal,
  token: string
): Promise<'created' | 'present'> {
  const keyHash = await hashApiKey(token);
  const prefix = token.slice(0, PREFIX_LENGTH);
  const created = await uow
    .run(admin, async (ctx) => {
      await ctx.apiKeys.insert({
        id: uuidv7(),
        name: 'seed',
        prefix,
        keyHash,
        capabilities: [...SEED_KEY_CAPABILITIES],
        createdBy: admin.actor,
        createdAt: new Date(),
      });
      return true;
    })
    .catch((e: { code?: string }) => {
      if (e.code === '23505') return false; // unique key_hash: seeded before
      throw e;
    });
  if (created) return 'created';

  // The hash is unique across tenants; a key this tenant cannot list belongs to another one.
  const stored = (await uow.run(admin, (ctx) => ctx.apiKeys.list())).find(
    (k) => k.name === 'seed' && k.prefix === prefix
  );
  const fix =
    'revoke key "seed" in the admin (or delete its row) and seed again, or set a new MYCEL_API_KEY';
  if (!stored) throw new Error(`MYCEL_API_KEY is already a key of another tenant; ${fix}`);
  if (stored.revokedAt) throw new Error(`MYCEL_API_KEY is a revoked key; ${fix}`);
  const missing = SEED_KEY_CAPABILITIES.filter((c) => !stored.capabilities.includes(c));
  if (missing.length > 0)
    throw new Error(
      `MYCEL_API_KEY was seeded before with fewer capabilities (missing ${missing.join(', ')}); ${fix}`
    );
  return 'present';
}
