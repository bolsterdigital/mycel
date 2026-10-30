// Who else is connected to the database a local test run is about to use (TODO #27). The local
// database is shared by every checkout on the machine, and a forgotten `npm run dev` or an
// orphaned API from an earlier session keeps its worker draining every tenant's outbox: a suite
// that waits for its own outbox row or mail then fails far from the diff (PR #167). The test
// preflight and the e2e runner print these sessions before they start, by name, and go on.
// Rejected: refusing to run, which would forbid `npm run dev` next to the tests; and naming the
// client process through `ss`/`lsof` on its port, which sees nothing behind Docker's NAT. Instead
// every pool `createDb` opens names its own process (`applicationName`).

import { basename } from 'node:path';
import pg from 'pg';

/**
 * The `application_name` a Mycel pool connects with: `PGAPPNAME` when set, else the entry script
 * and its pid (`mycel server.js pid 4242`), so a session in `pg_stat_activity` points at the
 * process to stop. Postgres keeps the first 63 bytes.
 */
export function applicationName(): string {
  return process.env.PGAPPNAME ?? `mycel ${basename(process.argv[1] ?? 'node')} pid ${process.pid}`;
}

export type ForeignSession = {
  pid: number;
  user: string;
  application: string;
  state: string | null;
  since: Date | null;
};

/** The other client sessions on `db`'s current database, oldest first; this one excluded. */
export async function foreignSessions(db: pg.ClientBase | pg.Pool): Promise<ForeignSession[]> {
  const { rows } = await db.query<ForeignSession>(
    `select pid, usename as "user", application_name as application, state,
            backend_start as since
     from pg_stat_activity
     where datname = current_database() and backend_type = 'client backend'
       and pid <> pg_backend_pid()
     order by backend_start nulls last, pid`
  );
  return rows;
}

/**
 * The warning for `sessions` on `database`, or null when there are none: one line per session,
 * with what it calls itself, its role and since when. A session without a name is an older Mycel
 * checkout or another client (psql, an IDE).
 */
export function sessionsWarning(
  database: string,
  sessions: ForeignSession[],
  now = new Date()
): string | null {
  if (!sessions.length) return null;
  const lines = sessions.map((s) => {
    const name = s.application ? `"${s.application}"` : 'unnamed client';
    const age = s.since ? `, connected ${minutes(now.getTime() - s.since.getTime())}` : '';
    return `  - ${name} as ${s.user}${s.state ? ` (${s.state})` : ''}${age}, backend pid ${s.pid}`;
  });
  return (
    `${sessions.length} other session(s) on database ${database}:\n${lines.join('\n')}\n` +
    "A running API or worker (npm run dev, an orphaned server) drains every tenant's outbox, so " +
    "a red test that waits for an outbox row or a mail may be theirs, not the diff's. Stop the " +
    'process the name points at, or give this checkout its own database ' +
    '(docs/architecture/testing.md § Local database).'
  );
}

const minutes = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
