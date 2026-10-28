// `MemoryUnitOfWork`: a transaction context composed from one factory per port, over a
// MemoryStore. Rejected: building the ports inline in `run` (it grew to one 700-line function
// that every module edited, TODO #53).

import type { InputHasher } from '../../audit/ports.js';
import { appDelivery } from '../../media/signed-paths.js';
import type { BlobStore, ImageProcessor, MediaDelivery } from '../../media/ports.js';
import type { Principal } from '../../principal.js';
import type {
  Clock,
  Ids,
  Logger,
  Signer,
  Subscriber,
  TransactionContext,
  UnitOfWork,
} from '../../ports.js';
import type { DnsResolver, PlatformConfig } from '../../tenants/ports.js';
import { noopLogger } from '../../util/log.js';
import { memoryAssist } from './assist.js';
import { memoryAudit } from './audit.js';
import { memoryConnectionIntents, memoryConnections } from './connections.js';
import { memoryContent, memorySite } from './content.js';
import { memoryErasures } from './erasures.js';
import {
  FakeClock,
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  SequentialIds,
  memoryPlatform,
} from './fakes.js';
import { memoryForms, memoryRateLimits, memorySubmissions } from './forms.js';
import { MemoryJobRecovery, MemoryScheduler } from './jobs.js';
import { memoryMailSends } from './mailing.js';
import { MemoryBlobStore, memoryImageProcessor, memoryMedia } from './media.js';
import { memoryApiKeys, memoryMembers, memoryOperators } from './operators.js';
import { MemoryStore, entityRepository, sluggedRepository, tenantLock } from './store.js';
import { memoryAdmissions, memorySupporters } from './supporters.js';
import { memoryExports, memoryHostnames, memoryUsage } from './tenants.js';

export interface MemoryDeps {
  store?: MemoryStore;
  log?: Logger;
  clock?: Clock;
  signer?: Signer;
  dns?: DnsResolver;
  platform?: PlatformConfig;
  blobs?: BlobStore;
  images?: ImageProcessor;
  delivery?: MediaDelivery;
  assistProviderLabel?: string | null;
}

export class MemoryUnitOfWork implements UnitOfWork {
  readonly store: MemoryStore;
  readonly clock: Clock;
  readonly ids: Ids = new SequentialIds();
  readonly signer: Signer;
  readonly dns: DnsResolver;
  readonly platform: PlatformConfig;
  readonly blobs: BlobStore;
  readonly images: ImageProcessor;
  readonly delivery: MediaDelivery;
  readonly log: Logger;
  readonly inputHasher: InputHasher = new FakeInputHasher();
  readonly assistProviderLabel: string | null;

  constructor(deps: MemoryDeps = {}) {
    this.log = deps.log ?? noopLogger;
    this.store = deps.store ?? new MemoryStore();
    this.clock = deps.clock ?? new FakeClock();
    this.signer = deps.signer ?? new FakeSigner();
    this.dns = deps.dns ?? new FakeDns();
    this.platform = deps.platform ?? memoryPlatform;
    this.blobs = deps.blobs ?? new MemoryBlobStore(this.clock);
    this.images = deps.images ?? memoryImageProcessor;
    this.delivery = deps.delivery ?? appDelivery;
    this.assistProviderLabel = deps.assistProviderLabel ?? null;
  }

  async run<T>(principal: Principal, fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const { store, clock, ids } = this;
    const tenantId = principal.tenantId;
    const s = store.for(tenantId);
    const memberLock = tenantLock(store.memberLocks, tenantId);
    const mediaLock = tenantLock(store.mediaLocks, tenantId);
    try {
      return await fn({
        principal,
        clock,
        ids,
        signer: this.signer,
        dns: this.dns,
        platform: this.platform,
        events: {
          async publish(event) {
            if (event.tenantId !== tenantId)
              throw new Error('event tenant differs from principal tenant');
            store.outbox.push(event);
          },
        },
        content: memoryContent(s),
        ...memorySite(s),
        assist: memoryAssist(s),
        connections: memoryConnections(s, principal),
        connectionIntents: memoryConnectionIntents(s),
        assistProviderLabel: this.assistProviderLabel,
        authors: sluggedRepository(s.authors),
        sections: sluggedRepository(s.sections),
        patterns: entityRepository(s.patterns),
        forms: memoryForms(s),
        submissions: memorySubmissions(s),
        rateLimits: memoryRateLimits(s, clock),
        supporters: memorySupporters(s, ids),
        admissions: memoryAdmissions(s, tenantId, clock),
        mailSends: memoryMailSends(s),
        operators: memoryOperators(store.operators),
        members: memoryMembers(s, store.operators, memberLock.lock),
        apiKeys: memoryApiKeys(s),
        hostnames: memoryHostnames(store, s),
        jobs: new MemoryScheduler(store, tenantId, ids, clock),
        jobRecovery: new MemoryJobRecovery(store, tenantId, clock),
        usage: memoryUsage(s, clock),
        media: memoryMedia(s, mediaLock.lock),
        blobs: this.blobs,
        images: this.images,
        delivery: this.delivery,
        log: this.log,
        audit: memoryAudit(s),
        inputHasher: this.inputHasher,
        erasures: memoryErasures(store, principal, clock),
        exports: memoryExports(s.exports),
      });
    } finally {
      memberLock.release();
      mediaLock.release();
    }
  }

  /** Deliver and clear the outbox, like the Postgres worker does after commit. */
  async drain(subscribers: readonly Subscriber[]): Promise<number> {
    const events = this.store.outbox.splice(0);
    for (const event of events)
      for (const sub of subscribers) if (sub.types.includes(event.type)) await sub.handle(event);
    return events.length;
  }
}
