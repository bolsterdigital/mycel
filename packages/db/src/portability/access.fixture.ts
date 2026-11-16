// Seed an access tier and a standing grant (migration 0068), so the export conformance carries an
// `access_tiers` row and a supporter whose `grants` is not empty through export and import.
// Rejected: leaving it to the catalog check alone, which proves the table is placed but not that
// a grant survives the round trip. `checkAccessCarried` reads back what this fixture put in.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { useCases, type Invoker, type Principal } from '@mycel/core';

export async function seedAccess(invoker: Invoker, admin: Principal, email: string) {
  const tier = await invoker.run(useCases.createAccessTier, admin, {
    slug: 'leden',
    kind: 'paid',
    name: { nl: 'Leden' },
  });
  const reader = await invoker.run(useCases.getSupporter, admin, { email });
  await invoker.run(useCases.createAccessGrant, admin, {
    supporterId: reader.id,
    tierId: tier.id,
    kind: 'comp',
    reason: 'Export fixture',
  });
}

export async function checkAccessCarried(tables: string) {
  const read = (table: string) => readFile(join(tables, `${table}.ndjson`), 'utf8');
  const tier = JSON.parse((await read('access_tiers')).trim().split('\n')[0]!) as {
    id: string;
    slug: string;
    kind: string;
  };
  expect(tier).toMatchObject({ slug: 'leden', kind: 'paid' });
  // The supporter's standing grant points at that tier, and the log holds the event behind it.
  expect(await read('supporters')).toContain(`"tierId": "${tier.id}"`);
  expect(await read('events')).toContain('access.granted');
}
