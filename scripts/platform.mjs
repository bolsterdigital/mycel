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
//   npm run platform -- ops summary
//   npm run platform -- ops list jobs|outbox|mail [<slug>]
//
// `ops` reads stuck work as mycel_ops (TODO #17c, migration 0016), the same functions as
// `/platform/ops/*`: never a payload, an event's props or its actor.

import { inputHasherOf, loadConfig, platformOf } from '@mycel/api/compose';
import {
  createDb,
  createTenant,
  getTenantBySlug,
  listTenants,
  opsDeadEvents,
  opsJobs,
  opsSummary,
  opsUnresolvedMail,
  setEntitlements,
  setStatus,
  uuidv7,
} from '@mycel/db';

const usage = `usage:
  npm run platform -- tenants list
  npm run platform -- tenants create <slug> <name> [locales, comma-separated]
  npm run platform -- entitlements set <slug> <json document>
  npm run platform -- status set <slug> active|suspended
  npm run platform -- ops summary
  npm run platform -- ops list jobs|outbox|mail [<slug>]`;

const OPS_LISTS = { jobs: opsJobs, outbox: opsDeadEvents, mail: opsUnresolvedMail };
const iso = (d) => (d ? new Date(d).toISOString() : '-');
const OPS_LINES = {
  jobs: (j) =>
    `${j.id}\t${j.tenantId ?? 'platform'}\t${j.type}\t${j.attempts}/${j.maxAttempts}\t${iso(j.createdAt)}\t${j.lastError ?? '-'}`,
  outbox: (e) =>
    `${e.id}\t${e.tenantId}\t${e.type}\t${e.attempts}\t${e.deliveredTo.join(',') || '-'}\t${e.lastError ?? '-'}`,
  mail: (m) =>
    `${m.key}\t${m.tenantId}\t${m.state}\t${m.subscriber}\t${m.attempts}\t${iso(m.attemptedAt)}\t${m.lastError ?? '-'}`,
};

const config = loadConfig();
if (!config.DATABASE_URL) {
  console.error('DATABASE_URL (the operator role) must be set (see .env.example)');
  process.exit(1);
}
const db = createDb(config.DATABASE_URL);
// Every mutation writes an audit row as `platform`, actor `cli` (TODO #17b).
const by = { actorId: 'cli', hasher: inputHasherOf(config) };
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
      platformOf(config),
      by
    );
    console.log(`platform: created tenant ${t.id} (${t.slug})`);
    show(t);
  } else if (noun === 'entitlements' && verb === 'set' && args[0] && args[1]) {
    const t = await bySlug(args[0]);
    const updated = await setEntitlements(db, t.id, JSON.parse(args[1]), by);
    console.log(
      `platform: tenant ${t.id} entitlements set to ${JSON.stringify(updated.storedEntitlements)}`
    );
    show(updated);
  } else if (noun === 'status' && verb === 'set' && args[0] && args[1]) {
    const t = await bySlug(args[0]);
    const updated = await setStatus(db, t.id, args[1], by);
    console.log(`platform: tenant ${t.id} status set to ${updated.status}`);
    show(updated);
  } else if (noun === 'ops' && verb === 'summary') {
    for (const s of await opsSummary(db))
      console.log(
        `${s.slug ?? 'platform'}\tjobs ${s.exhaustedJobs}\toutbox ${s.deadEvents}\tmail unknown ${s.unknownMail}\tabandoned ${s.abandonedMail}`
      );
  } else if (noun === 'ops' && verb === 'list' && Object.hasOwn(OPS_LISTS, args[0] ?? '')) {
    const tenantId = args[1] ? (await bySlug(args[1])).id : undefined;
    let cursor;
    do {
      const page = await OPS_LISTS[args[0]](db, { tenantId, cursor, limit: 200 });
      for (const row of page.items) console.log(OPS_LINES[args[0]](row));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
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
