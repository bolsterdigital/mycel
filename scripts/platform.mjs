#!/usr/bin/env node
// Platform operations for a self-hoster (TODO #16, ADR 015 rule 4): the same functions as the
// platform API (packages/db/src/platform.ts), on the operator connection, without a token,
// because whoever holds DATABASE_URL already holds everything. The functions enter
// `mycel_platform` themselves (0010), so the CLI and the API run under the same grants. `mycel setup` (TODO #18) takes
// this over. Rejected: calling the platform API over HTTP from here, which would make a
// self-hoster run the API with PLATFORM_API_TOKEN just to change a limit.
//
//   npm run platform -- tenants list
//   npm run platform -- tenants create <slug> <name> [nl,en]
//   npm run platform -- entitlements set <slug> '{"supporters.max": 250}'
//   npm run platform -- status set <slug> active|suspended

import { loadConfig, platformOf } from '@mycel/api/compose';
import {
  createDb,
  createTenant,
  getTenantBySlug,
  listTenants,
  setEntitlements,
  setStatus,
  uuidv7,
} from '@mycel/db';

const usage = `usage:
  npm run platform -- tenants list
  npm run platform -- tenants create <slug> <name> [locales, comma-separated]
  npm run platform -- entitlements set <slug> <json document>
  npm run platform -- status set <slug> active|suspended`;

const config = loadConfig();
if (!config.DATABASE_URL) {
  console.error('DATABASE_URL (the operator role) must be set (see .env.example)');
  process.exit(1);
}
const db = createDb(config.DATABASE_URL);
const [noun, verb, ...args] = process.argv.slice(2);

const show = (t) =>
  console.log(
    `${t.slug}\t${t.status}\t${t.primaryHostname ?? '-'}\t${t.id}\t${JSON.stringify(t.storedEntitlements)}`
  );

async function bySlug(slug) {
  const tenant = slug && (await getTenantBySlug(db, slug));
  if (!tenant) throw new Error(`no tenant with slug "${slug}"`);
  return tenant;
}

try {
  if (noun === 'tenants' && verb === 'list') {
    for (const t of await listTenants(db)) show(t);
  } else if (noun === 'tenants' && verb === 'create' && args[0] && args[1]) {
    const locales = (args[2] ?? 'nl')
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);
    const t = await createTenant(
      db,
      { id: uuidv7(), slug: args[0], name: args[1], locales },
      platformOf(config)
    );
    console.log(`platform: created tenant ${t.id} (${t.slug})`);
    show(t);
  } else if (noun === 'entitlements' && verb === 'set' && args[0] && args[1]) {
    const t = await bySlug(args[0]);
    const updated = await setEntitlements(db, t.id, JSON.parse(args[1]));
    console.log(
      `platform: tenant ${t.id} entitlements set to ${JSON.stringify(updated.storedEntitlements)}`
    );
    show(updated);
  } else if (noun === 'status' && verb === 'set' && args[0] && args[1]) {
    const t = await bySlug(args[0]);
    const updated = await setStatus(db, t.id, args[1]);
    console.log(`platform: tenant ${t.id} status set to ${updated.status}`);
    show(updated);
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
} catch (e) {
  console.error(e.issues?.length ? `${e.message}: ${JSON.stringify(e.issues)}` : e.message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
