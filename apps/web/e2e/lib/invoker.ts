// Fixtures go in through the use cases, as the admin and the API write them: a registry invoker
// on the application login (`mycel_app`, under the tenant's RLS), with the fakes of
// `@mycel/core/testing` for the clock-free parts the server under test would bring itself.
// The schema owner only looks a tenant up or makes one; it never writes tenant rows here.
// Rejected: a unit of work per spec (eleven copies in seven files, each with its own subset of
// options, so the audit hash key differed between fixtures of one run).

import { Invoker, buildRegistry, type UnitOfWork } from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import {
  createDb,
  createTenantDirectory,
  createUnitOfWork,
  uuidv7Ids,
  type UnitOfWorkDeps,
} from '@mycel/db';

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

/** The id of a seeded tenant, `probe` unless named. */
export async function tenantId(slug = 'probe'): Promise<string> {
  const tenant = await asOwner((owner) => createTenantDirectory(owner).findBySlug(slug));
  if (!tenant) throw new Error(`tenant ${slug} missing`);
  return tenant.id;
}
