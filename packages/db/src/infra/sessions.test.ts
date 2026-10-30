// The foreign-session warning of the test preflight and the e2e runner (TODO #27): a pool from
// `createDb` names its process, `foreignSessions` lists it and never the asking session, and the
// warning names it with role and age. Other suites run in parallel, so the database part only
// looks for its own named sessions, never for an empty list. Skips without DATABASE_URL.

import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { runSuffix } from '@mycel/core/testing';
import { createDb } from '../index.js';
import { requireDatabase } from '../testing.js';
import {
  applicationName,
  foreignSessions,
  sessionsWarning,
  type ForeignSession,
} from './sessions.js';

const { skip, operator: operatorUrl } = requireDatabase();

describe('sessionsWarning', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  const session = (over: Partial<ForeignSession>): ForeignSession => ({
    pid: 101,
    user: 'mycel',
    application: 'mycel npm run dev api, pid 4242',
    state: 'idle',
    since: new Date('2026-10-30T11:15:00Z'),
    ...over,
  });

  it('is null without other sessions', () => {
    expect(sessionsWarning('mycel', [], now)).toBeNull();
  });

  it('names each session with its role, state and age, and says what it does to a run', () => {
    const warning = sessionsWarning(
      'mycel',
      [session({}), session({ pid: 102, application: '', user: 'mycel_app', state: null })],
      now
    );
    expect(warning).toContain('2 other session(s) on database mycel');
    expect(warning).toContain(
      '"mycel npm run dev api, pid 4242" as mycel (idle), connected 45 min ago, backend pid 101'
    );
    expect(warning).toContain('unnamed client as mycel_app, connected 45 min ago, backend pid 102');
    expect(warning).toContain('outbox');
    expect(warning).toContain('§ Local database');
  });

  it('applicationName prefers PGAPPNAME and otherwise names entry script and pid', () => {
    const before = process.env.PGAPPNAME;
    try {
      delete process.env.PGAPPNAME;
      expect(applicationName()).toMatch(new RegExp(`^mycel \\S+ pid ${process.pid}$`));
      process.env.PGAPPNAME = 'mycel npm run dev api, pid 1';
      expect(applicationName()).toBe('mycel npm run dev api, pid 1');
    } finally {
      if (before === undefined) delete process.env.PGAPPNAME;
      else process.env.PGAPPNAME = before;
    }
  });
});

describe.skipIf(skip)('foreignSessions', () => {
  const asking = new pg.Client({ connectionString: operatorUrl });
  const name = `sessions-test ${runSuffix()}`;
  const before = process.env.PGAPPNAME;
  process.env.PGAPPNAME = name;
  const db = createDb(operatorUrl);
  if (before === undefined) delete process.env.PGAPPNAME;
  else process.env.PGAPPNAME = before;

  afterAll(async () => {
    await db.destroy();
    await asking.end();
  });

  it('lists a createDb pool by its name and leaves the asking session out', async () => {
    await asking.connect();
    await sql`select 1`.execute(db);
    const sessions = await foreignSessions(asking);
    const own = (await asking.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0];

    expect(sessions.filter((s) => s.application === name)).toHaveLength(1);
    expect(sessions.find((s) => s.application === name)?.since).toBeInstanceOf(Date);
    expect(sessions.map((s) => s.pid)).not.toContain(own?.pid);
  });
});
