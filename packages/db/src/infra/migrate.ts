// Forward-only SQL migrations (ADR 008 policy 1: our own ~60 lines instead of a migration
// library). Files in ../migrations named NNNN_name.sql run in name order, each in its own
// transaction, recorded in `schema_migrations` with the sha256 of the file. An advisory lock keeps
// two deploys from racing. There is no "down": a mistake is fixed by the next migration, and a file
// that changed after it was applied stops the runner before it touches anything (TODO #18b,
// docs/upgrading.md). Rejected: a numbered migration for the checksum column, which the runner
// itself would need before it could check that migration.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const LOCK_KEY = 4_242_001;
/** First month with event partitions; older rows (a backfill) need their own range first. */
export const FIRST_EVENT_MONTH = '2026-10-01';

/**
 * Create the monthly `events` partitions for [from, to] that do not exist yet (ADR 003
 * consequence 1); returns how many it created. Idempotent. `migrate` covers the first month up to
 * three months ahead on every run, and the worker's monthly `events.partitions` job keeps that
 * going without a deploy (`createEventPartitions`, TODO #15); a backfill calls this with its own
 * range before inserting, so nothing lands in `events_default`. Fails with a recovery hint when
 * `events_default` already holds rows of a month in the range (0009). Runs as the operator:
 * mycel_app cannot execute it (0005).
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

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Versions recorded in `schema_migrations` that have no file in `dir`: the database was migrated
 * by a newer branch or image. `migrate` accepts that (after a rollback the newer schema stays),
 * but a test run against such a database proves another schema than the checkout's, and an
 * export from it refuses to import into a fresh one. The test preflights (scripts/
 * test-db-preflight.mjs, scripts/e2e.mjs) stop on it with one message instead (TODO #27).
 */
export async function migrationsAhead(
  db: pg.ClientBase | pg.Pool,
  dir: string = MIGRATIONS_DIR
): Promise<string[]> {
  const { rows } = await db
    .query<{ version: string }>('select version from schema_migrations order by version')
    .catch((e: { code?: string }) => {
      if (e.code === '42P01') return { rows: [] }; // no schema_migrations: an empty database
      throw e;
    });
  const files = new Set(
    (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).map((f) => f.slice(0, -4))
  );
  return rows.map((r) => r.version).filter((v) => !files.has(v));
}

/**
 * Apply the pending files of `dir` on `client`, in the schema its `search_path` names; returns
 * the versions it applied. Refuses, before applying or recording anything, when an applied file
 * no longer matches its recorded checksum. Rows from before TODO #18b have no checksum and get the
 * file's current one. A recorded version without a file (an image one release back, after a
 * rollback) is fine: forward-only means the newer schema stays. The caller holds the lock.
 */
export async function applyMigrations(
  client: pg.ClientBase,
  dir: string,
  log: (m: string) => void = () => {}
): Promise<string[]> {
  await client.query(`create table if not exists schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
  )`);
  await client.query('alter table schema_migrations add column if not exists checksum text');
  const recorded = new Map(
    (
      await client.query<{ version: string; checksum: string | null }>(
        'select version, checksum from schema_migrations'
      )
    ).rows.map((r) => [r.version, r.checksum])
  );
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const texts = new Map<string, string>();
  for (const file of files) texts.set(file, await readFile(dir + file, 'utf8'));

  const changed = files.filter((file) => {
    const checksum = recorded.get(file.replace(/\.sql$/, ''));
    return checksum != null && checksum !== sha256(texts.get(file)!);
  });
  if (changed.length)
    throw new Error(
      `applied migration(s) changed since they ran: ${changed.join(', ')}. ` +
        'Migrations are never edited once applied; restore the file and fix it in a new migration.'
    );

  const applied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const text = texts.get(file)!;
    if (recorded.has(version)) {
      if (recorded.get(version) == null)
        await client.query('update schema_migrations set checksum = $2 where version = $1', [
          version,
          sha256(text),
        ]);
      continue;
    }
    await client.query('begin');
    try {
      await client.query(text);
      await client.query('insert into schema_migrations (version, checksum) values ($1, $2)', [
        version,
        sha256(text),
      ]);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${(e as Error).message}`);
    }
    applied.push(version);
    log(`applied ${version}`);
  }
  return applied;
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
    applied.push(...(await applyMigrations(client, MIGRATIONS_DIR, log)));
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
