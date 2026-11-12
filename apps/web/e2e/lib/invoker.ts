// Fixtures go in through the use cases, as the admin and the API write them: a registry invoker
// on the application login (`mycel_app`, under the tenant's RLS), with the fakes of
// `@mycel/core/testing` for the clock-free parts the server under test would bring itself.
// The schema owner only looks a tenant up or makes one; it never writes tenant rows here.
// A stuck job is the one fixture written as the queue's own role (`mycel_worker`): no use case
// makes a job give up, and the status page and the notifications both read it.
// Rejected: a unit of work per spec (eleven copies in seven files, each with its own subset of
// options, so the audit hash key differed between fixtures of one run).

import { Invoker, buildRegistry, type UnitOfWork } from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import {
  applyErasures,
  createDb,
  createTenantDirectory,
  createUnitOfWork,
  uuidv7,
  uuidv7Ids,
  type Database,
  type UnitOfWorkDeps,
} from '@mycel/db';
import { asRole } from '@mycel/db/testing';
import { type Kysely } from 'kysely';

type Db = ReturnType<typeof createDb>;

/** A unit of work on `db` with the e2e fakes; `extra` adds what one fixture needs. */
export const testUnitOfWork = (db: Db, extra: Partial<UnitOfWorkDeps> = {}) =>
  createUnitOfWork(db, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(process.env['AUDIT_HASH_KEY']),
    dns: new FakeDns(),
    platform: memoryPlatform,
    ...extra,
  });

/**
 * Run `fn` with an invoker on a fresh application connection, and close it after. The unit of
 * work is there for a fixture no use case writes (a seeded intent, a media usage).
 */
export async function withInvoker<T>(
  fn: (invoker: Invoker, uow: UnitOfWork) => Promise<T>,
  extra: Partial<UnitOfWorkDeps> = {}
): Promise<T> {
  const db = createDb(process.env['APP_DATABASE_URL']!);
  try {
    const uow = testUnitOfWork(db, extra);
    return await fn(new Invoker(buildRegistry(), uow), uow);
  } finally {
    await db.destroy();
  }
}

/** Run `fn` on the schema owner's connection, and close it after. */
export async function asOwner<T>(fn: (owner: Db) => Promise<T>): Promise<T> {
  const owner = createDb(process.env['DATABASE_URL']!);
  try {
    return await fn(owner);
  } finally {
    await owner.destroy();
  }
}

/**
 * What the worker's `person.erase` and `supporter.erase` jobs do: apply the tenant's erasure
 * registers on the owner's connection, which may enter mycel_erasure. A spec that needs the
 * outcome of an erasure runs it here instead of waiting for the worker.
 */
export async function applyErasuresOf(slug = 'probe'): Promise<number> {
  const id = await tenantId(slug);
  return asOwner((owner) => applyErasures(owner, id));
}

/** The id of a seeded tenant, `probe` unless named. */
export async function tenantId(slug = 'probe'): Promise<string> {
  const tenant = await asOwner((owner) => createTenantDirectory(owner).findBySlug(slug));
  if (!tenant) throw new Error(`tenant ${slug} missing`);
  return tenant.id;
}

/** As mycel_worker, the queue's own role: insert stuck jobs for tenant probe, or finish jobs. */
async function asWorker(fn: (trx: Kysely<Database>, probeId: string) => Promise<void>) {
  const probe = await tenantId();
  await asOwner((db) => asRole(db, 'mycel_worker', (trx) => fn(trx, probe)));
}

/** A job of tenant probe out of attempts; its type names the test, so each finds only its own. */
export async function stuckJob(type: string): Promise<string> {
  const id = uuidv7();
  await asWorker(async (trx, probeId) => {
    await trx
      .insertInto('jobs')
      .values({
        id,
        tenant_id: probeId,
        type,
        key: `${type}:${id}`,
        run_at: new Date(Date.now() + 86_400_000),
        payload: JSON.stringify({ secret: 'e2e-payload' }),
        attempts: 10,
        max_attempts: 10,
        last_error: 'delivery failed for e2e-person@example.org',
      })
      .execute();
  });
  return id;
}

/** Marks jobs done, so a test leaves no stuck job behind. */
export async function finishJobs(ids: string[]) {
  if (!ids.length) return;
  await asWorker(async (trx) => {
    await trx
      .updateTable('jobs')
      .set({ done_at: new Date() })
      .where('id', 'in', ids)
      .where('done_at', 'is', null)
      .execute();
  });
}
