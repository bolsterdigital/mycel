#!/usr/bin/env node
// The restore drill's fingerprint (TODO #18c, scripts/drill-run.sh): what a restore must give back
// unchanged, as one JSON document, and a comparison of two of them.
//
//   node scripts/drill-verify.mjs fingerprint > before.json
//   node scripts/drill-verify.mjs compare before.json after.json   # exit 1 on any difference
//
// Per table in `public` (from the catalog, so a new table is covered without a list), and within
// a tenant table per tenant: the number of rows and a sha256 over the rows' text, sorted. Whole rows
// rather than ids alone, so a restore that keeps the keys but loses a column's value still fails.
// Per object in the bucket a sha256 of its bytes. The last applied migration. And per `mycel*`
// role its attributes, settings and memberships: no pg_dump carries roles, backup.sh writes them
// as roles.sql, and a migration that gives a role an attribute roles.sql does not know fails here
// instead of after a real restore.
//
// Reads through DRILL_BACKUP_DATABASE_URL, the read-only `mycel_backup` login with BYPASSRLS: the
// owner sees no tenant row under forced RLS (0018), and mycel_app only one tenant at a time. The
// bucket through the BLOB_S3_* keys the application reads.
// Rejected: comparing two pg_dump files, which differ in timestamps and object order between runs
// and say nothing about the media files.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

async function fingerprint() {
  const client = new pg.Client({ connectionString: process.env.DRILL_BACKUP_DATABASE_URL });
  await client.connect();
  const tables = {};
  try {
    const { rows: relations } = await client.query(`
      select c.relname as name,
             exists (select from pg_attribute a where a.attrelid = c.oid
                     and a.attname = 'tenant_id' and not a.attisdropped) as tenant_owned
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
        and not c.relispartition
      order by c.relname`);
    for (const { name, tenant_owned } of relations) {
      const group = tenant_owned ? 't.tenant_id::text' : `'-'`;
      const { rows } = await client.query(
        `select ${group} as tenant, count(*)::int as rows,
                encode(sha256(convert_to(coalesce(string_agg(t::text, E'\\n' order by t::text), ''),
                       'UTF8')), 'hex') as sha256
         from ${pg.escapeIdentifier(name)} t group by 1 order by 1`
      );
      tables[name] = Object.fromEntries(
        rows.map((r) => [r.tenant, { rows: r.rows, sha256: r.sha256 }])
      );
    }
    const { rows: migration } = await client.query(
      'select max(version) as version from schema_migrations'
    );
    const { rows: roles } = await client.query(`
      select r.rolname as name, r.rolcanlogin as login, r.rolinherit as inherit,
             r.rolcreaterole as createrole, r.rolbypassrls as bypassrls, r.rolconfig as config,
             array(select format('%s inherit %s set %s admin %s', g.rolname,
                                 am.inherit_option, am.set_option, am.admin_option)
                   from pg_auth_members am join pg_roles g on g.oid = am.roleid
                   where am.member = r.oid order by 1) as memberships
      from pg_roles r where r.rolname like 'mycel%' order by r.rolname`);
    return {
      lastMigration: migration[0].version,
      tables,
      blobs: await blobs(),
      roles: Object.fromEntries(roles.map(({ name, ...role }) => [name, role])),
    };
  } finally {
    await client.end();
  }
}

async function blobs() {
  const s3 = new S3Client({
    endpoint: process.env.BLOB_S3_ENDPOINT,
    region: process.env.BLOB_S3_REGION ?? 'us-east-1',
    forcePathStyle: process.env.BLOB_S3_FORCE_PATH_STYLE === '1',
    credentials: {
      accessKeyId: process.env.BLOB_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.BLOB_S3_SECRET_ACCESS_KEY,
    },
  });
  const Bucket = process.env.BLOB_S3_BUCKET;
  const out = {};
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket, ContinuationToken }));
    for (const { Key } of page.Contents ?? []) {
      const object = await s3.send(new GetObjectCommand({ Bucket, Key }));
      out[Key] = sha256(Buffer.from(await object.Body.transformToByteArray()));
    }
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
  s3.destroy();
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Every difference between two fingerprints, as readable lines; empty when equal. */
function differences(before, after) {
  const lines = [];
  if (before.lastMigration !== after.lastMigration)
    lines.push(`last migration: ${before.lastMigration} -> ${after.lastMigration}`);
  for (const table of new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])) {
    const a = before.tables[table] ?? {};
    const b = after.tables[table] ?? {};
    for (const tenant of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const x = a[tenant];
      const y = b[tenant];
      if (x?.sha256 !== y?.sha256)
        lines.push(
          `${table} [${tenant}]: ${x?.rows ?? 'absent'} rows -> ${y?.rows ?? 'absent'} rows`
        );
    }
  }
  for (const key of new Set([...Object.keys(before.blobs), ...Object.keys(after.blobs)]))
    if (before.blobs[key] !== after.blobs[key])
      lines.push(`blob ${key}: ${before.blobs[key] ? 'changed or lost' : 'appeared'}`);
  for (const name of new Set([...Object.keys(before.roles), ...Object.keys(after.roles)]))
    if (JSON.stringify(before.roles[name]) !== JSON.stringify(after.roles[name]))
      lines.push(
        `role ${name}: ${JSON.stringify(before.roles[name] ?? 'absent')} -> ` +
          JSON.stringify(after.roles[name] ?? 'absent')
      );
  return lines;
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'fingerprint') {
  console.log(JSON.stringify(await fingerprint(), null, 2));
} else if (command === 'compare' && rest.length === 2) {
  const [before, after] = rest.map((file) => JSON.parse(readFileSync(file, 'utf8')));
  const lines = differences(before, after);
  const tenantRows = Object.values(before.tables)
    .flatMap((byTenant) => Object.entries(byTenant).filter(([t]) => t !== '-'))
    .reduce((sum, [, v]) => sum + v.rows, 0);
  if (lines.length) {
    console.error(`fingerprints differ in ${lines.length} place(s):`);
    for (const line of lines) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(
    `fingerprints equal: ${Object.keys(before.tables).length} tables, ${tenantRows} tenant rows, ` +
      `${Object.keys(before.blobs).length} media objects, ${Object.keys(before.roles).length} ` +
      `roles, migration ${before.lastMigration}`
  );
} else {
  console.error('usage: drill-verify.mjs fingerprint | compare <before.json> <after.json>');
  process.exit(64);
}
