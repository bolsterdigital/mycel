// In-memory implementations of every port (ADR 001 consequence: the core is testable without a
// database). Used by core tests and by front tests (api, mcp) that need a working runtime.
// Not transactional: a thrown use case leaves partial writes, which the tests do not rely on.
// Two locks are real: `members.lock()` and `media.lock()` queue per tenant until `run` ends, like
// the advisory locks in Postgres, so the key/membership race (TODO #20a) and the media
// save/delete race (TODO #8b2) can be proven here too.
//
// One file per module under `memory/`, one factory per port; `MemoryUnitOfWork.run` only
// composes them. This file is the public surface (`@mycel/core/testing`) and lists it by name,
// so a helper added to a module stays internal until it is exported here.
// Rejected: `export *` from every module (the factories and `TenantStore` would become API).

export {
  FakeClock,
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryErrorReporter,
  MemoryLogger,
  MemoryMailer,
  MemoryTenants,
  SequentialIds,
  memoryPlatform,
  testPlatformActor,
} from './memory/fakes.js';
export { MemoryStore, type OperatorRow } from './memory/store.js';
export { MemoryJobRecovery, MemoryScheduler } from './memory/jobs.js';
export { MemoryBlobStore, memoryImageProcessor } from './memory/media.js';
export { secureErasures } from './memory/erasures.js';
export { memoryExportLifecycle } from './memory/export-jobs.js';
export { MemoryIdentityStore } from './memory/operators.js';
export { MemorySiteDirectory } from './memory/tenants.js';
export { MemoryUnitOfWork, type MemoryDeps } from './memory/unit-of-work.js';
