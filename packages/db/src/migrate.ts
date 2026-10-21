// Forward-only SQL migrations (ADR 008 policy 1: our own ~60 lines instead of a migration
// library). Files in ../migrations named NNNN_name.sql run in name order, each in its own
// transaction, recorded in `schema_migrations`. An advisory lock keeps two deploys from racing.
// There is no "down": a mistake is fixed by the next migration.

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const LOCK_KEY = 4_242_001;
/** First month with event partitions; older rows (a backfill) need their own range first. */
export const FIRST_EVENT_MONTH = '2026-10-01';

/**
 * Create the monthly `events` partitions for [from, to] that do not exist yet (ADR 003
 * consequence 1); returns how many it created. Idempotent. `migrate` covers the first month up to
 * three months ahead on every run; a backfill calls this with its own range before inserting, so
 * nothing lands in `events_default`. Runs as the operator: mycel_app cannot execute it (0005).
 */
export async function ensureEventPartitions(
  db: pg.ClientBase | pg.Pool,
  from: Date | string,
  to: Date | string
): Promise<number> {
  const day = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString().slice(0, 10));
  const { rows } = await db.query<{ n: number }>(
    'select ensure_event_partitions($1::date, $2::date) as n',
    [day(from), day(to)]
  );
  return rows[0]!.n;
}

export async function migrate(
  connectionString: string,
  {
    appPassword,
    authPassword,
    log = console.log,
  }: {
    appPassword?: string | undefined;
    authPassword?: string | undefined;
    log?: (m: string) => void;
  } = {}
): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )`);
    const done = new Set(
      (await client.query<{ version: string }>('select version from schema_migrations')).rows.map(
        (r) => r.version
      )
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) continue;
      const text = await readFile(MIGRATIONS_DIR + file, 'utf8');
      await client.query('begin');
      try {
        await client.query(text);
        await client.query('insert into schema_migrations (version) values ($1)', [version]);
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(e as Error).message}`);
      }
      applied.push(version);
      log(`applied ${version}`);
    }
    const ahead = new Date();
    ahead.setUTCDate(1);
    ahead.setUTCMonth(ahead.getUTCMonth() + 3);
    const created = await ensureEventPartitions(client, FIRST_EVENT_MONTH, ahead);
    if (created) log(`created ${created} event partition(s)`);
    // Operator-supplied passwords turn the nologin runtime roles into the fronts' logins:
    // mycel_app for tenant data (0001), mycel_authenticator for authentication (0007).
    for (const [role, password] of [
      ['mycel_app', appPassword],
      ['mycel_authenticator', authPassword],
    ] as const) {
      if (!password) continue;
      const { rows } = await client.query<{ q: string }>(
        `select format('alter role %I with login password %L', $1::text, $2::text) as q`,
        [role, password]
      );
      await client.query(rows[0]!.q);
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return applied;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set (see .env.example)');
    process.exit(1);
  }
  migrate(url, {
    appPassword: process.env['MYCEL_APP_PASSWORD'],
    authPassword: process.env['MYCEL_AUTH_PASSWORD'],
  })
    .then((applied) =>
      console.log(applied.length ? `${applied.length} migration(s) applied` : 'schema up to date')
    )
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
