// Vitest global setup (vitest.config.ts): before any database suite runs, refuse a DATABASE_URL
// whose schema is ahead of this checkout. A local database is shared by every branch checked out
// on the machine, and after a branch with a new migration it holds versions this checkout has no
// file for; its suites then fail in places that have nothing to do with the diff (an export
// recording the newer schema cannot import into a fresh database) or pass on the wrong schema,
// while CI on an empty database is green (TODO #27). One message here instead of scattered reds.
// Rejected: making `migrate` refuse it, which would break a production rollback (migrate.ts).
// Without DATABASE_URL the database suites skip, and so does this check.

import pg from 'pg';
import { migrationsAhead } from '../packages/db/src/migrate.ts';

export default async function preflight() {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch {
    return; // An unreachable database fails in the suites themselves, with their own message.
  }
  try {
    const ahead = await migrationsAhead(client);
    if (ahead.length) {
      const error = new Error(
        `DATABASE_URL (${client.database}) has migration(s) this checkout does not know: ` +
          `${ahead.join(', ')}. A newer branch migrated it, so tests here would prove another ` +
          'schema. Point DATABASE_URL, APP_DATABASE_URL and AUTH_DATABASE_URL at a database ' +
          'for this checkout (docs/architecture/testing.md § Local database), or check out ' +
          'the branch that added them.'
      );
      // Without frames: Vitest 5's module runner fails to map a global setup's stack
      // (`code.charCodeAt is not a function`) and would print that instead of this message.
      error.stack = `Error: ${error.message}`;
      throw error;
    }
  } finally {
    await client.end();
  }
}
