import {
  unavailableMailchimp,
  type MailchimpDiscovery,
} from '../../connections/mailchimp/ports.js';
// `MemoryUnitOfWork`: a transaction context composed from one factory per port, over a
// MemoryStore. Rejected: building the ports inline in `run` (it grew to one 700-line function
// that every module edited, TODO #53).

import { memoryFormFeeds } from './forms.js';
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
import { memoryNavigation } from './navigation.js';
import { memoryAudit } from './audit.js';
import {
  memoryConnectionIntents,
  memoryConnections,
  memoryMailchimpReceipts,
} from './connections.js';
import { memoryBulkPlans, memoryContent, memoryPresence, memorySite } from './content.js';
import { memoryErasures } from './erasures/repository.js';
import { memoryPersonErasures } from './erasures/people.js';
import { memoryCampaigns } from './campaigns.js';
import { memoryPayments } from './money/payments.js';
import { memorySubscriptions } from './money/subscriptions.js';
import type { PaymentProvider } from '../../money/ports.js';
import {
  FakeClock,
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  SequentialIds,
  memoryPlatform,
} from './fakes.js';
import { memoryFormMail, memoryForms, memoryRateLimits, memorySubmissions } from './forms.js';
import { MemoryJobRecovery, MemoryScheduler } from './operations/jobs.js';
import { memoryMailAutomations, memoryMailEditions, memoryMailSends } from './mailing.js';
import type { EmailRenderer } from '../../mailing/ports.js';
import { memoryVideos } from './media/video.js';
import type { VideoProvider } from '../../media/ports.js';
import { MemoryBlobStore, memoryImageProcessor, memoryMedia } from './media.js';
import {
  memoryApiKeys,
  memoryAttentionReads,
  memoryMembers,
  memoryOperators,
} from './operators.js';
import { MemoryStore, entityRepository, paged, sluggedRepository, tenantLock } from './store.js';
import {
  memoryAdmissions,
  memoryReaderSessions,
  memorySigninLinks,
  memorySupporters,
} from './supporters.js';
import { memoryExports, memoryHostnames, memoryLaunchSteps, memoryUsage } from './tenants.js';

export interface MemoryDeps {
  store?: MemoryStore;
  log?: Logger;
  clock?: Clock;
  /** Ascending by default; a case about order may hand out ids that run the other way. */
  ids?: Ids;
  signer?: Signer;
  dns?: DnsResolver;
  platform?: PlatformConfig;
  blobs?: BlobStore;
  images?: ImageProcessor;
  delivery?: MediaDelivery;
  assistProviderLabel?: string | null;
  mailchimpDiscovery?: MailchimpDiscovery;
  emailRenderer?: EmailRenderer;
  videoProvider?: VideoProvider;
  paymentProvider?: PaymentProvider | null;
}

/**
 * The mail model as JSON: enough for a use case test to see what reached the renderer. The real
 * markup is `packages/render-email`, which the core cannot import.
 */
export const memoryEmailRenderer: EmailRenderer = {
  render: (email) => ({ html: JSON.stringify(email), text: JSON.stringify(email) }),
};

export class MemoryUnitOfWork implements UnitOfWork {
  readonly videoProvider: VideoProvider | null;
  readonly store: MemoryStore;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly signer: Signer;
  readonly dns: DnsResolver;
  readonly platform: PlatformConfig;
  readonly blobs: BlobStore;
  readonly images: ImageProcessor;
  readonly delivery: MediaDelivery;
  readonly log: Logger;
  readonly inputHasher: InputHasher = new FakeInputHasher();
  readonly mailchimpDiscovery: MailchimpDiscovery;
  readonly assistProviderLabel: string | null;
  readonly emailRenderer: EmailRenderer;
  readonly paymentProvider: PaymentProvider | null;

  constructor(deps: MemoryDeps = {}) {
    this.mailchimpDiscovery = deps.mailchimpDiscovery ?? unavailableMailchimp;
    this.log = deps.log ?? noopLogger;
    this.videoProvider = deps.videoProvider ?? null;
    this.store = deps.store ?? new MemoryStore();
    this.clock = deps.clock ?? new FakeClock();
    this.ids = deps.ids ?? new SequentialIds();
    this.signer = deps.signer ?? new FakeSigner();
    this.dns = deps.dns ?? new FakeDns();
    this.platform = deps.platform ?? memoryPlatform;
    this.blobs = deps.blobs ?? new MemoryBlobStore(this.clock);
    this.images = deps.images ?? memoryImageProcessor;
    this.delivery = deps.delivery ?? appDelivery;
    this.assistProviderLabel = deps.assistProviderLabel ?? null;
    this.emailRenderer = deps.emailRenderer ?? memoryEmailRenderer;
    this.paymentProvider = deps.paymentProvider ?? null;
  }

  async run<T>(principal: Principal, fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const { store, clock, ids } = this;
    const tenantId = principal.tenantId;
    const s = store.for(tenantId);
    const bulkLock = tenantLock(store.bulkLocks, tenantId);
    const memberLock = tenantLock(store.memberLocks, tenantId);
    const mediaLock = tenantLock(store.mediaLocks, tenantId);
    const navigationLock = tenantLock(store.navigationLocks, tenantId);
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
            store.keptEvents.add(event.id);
          },
          exists: async (id) => store.keptEvents.has(id),
        },
        content: memoryContent(s),
        campaigns: memoryCampaigns(s),
        payments: memoryPayments(s),
        subscriptions: memorySubscriptions(s),
        paymentProvider: this.paymentProvider,
        bulkPlans: memoryBulkPlans(s, bulkLock.lock),
        presence: memoryPresence(s),
        navigation: memoryNavigation(s, navigationLock.lock),
        ...memorySite(s),
        assist: memoryAssist(s),
        mailchimpReceipts: memoryMailchimpReceipts(s),
        mailchimpDiscovery: this.mailchimpDiscovery,
        connections: memoryConnections(s, principal),
        connectionIntents: memoryConnectionIntents(s),
        assistProviderLabel: this.assistProviderLabel,
        emailRenderer: this.emailRenderer,
        authors: {
          ...sluggedRepository(s.authors),
          list: async (after, limit, kind) =>
            paged(
              [...s.authors.values()].filter((p) => !kind || p.kind === kind),
              after,
              limit
            ),
        },
        personGroups: {
          ...entityRepository(s.personGroups),
          list: async (offset, limit) =>
            structuredClone(
              [...s.personGroups.values()]
                .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
                .slice(offset, offset + limit)
            ),
          async update(group, base) {
            const current = s.personGroups.get(group.id);
            if (!current || Date.parse(current.updatedAt) !== Date.parse(base)) return false;
            s.personGroups.set(group.id, structuredClone(group));
            return true;
          },
        },
        sections: sluggedRepository(s.sections),
        accessTiers: sluggedRepository(s.accessTiers),
        patterns: {
          ...entityRepository(s.patterns),
          remove: async (id) => s.patterns.delete(id),
        },
        formMail: memoryFormMail(s),
        formFeeds: memoryFormFeeds(s),
        forms: memoryForms(s),
        submissions: memorySubmissions(s),
        rateLimits: memoryRateLimits(s, clock),
        supporters: memorySupporters(s, ids),
        admissions: memoryAdmissions(s, tenantId, clock),
        mailSends: memoryMailSends(s),
        mailEditions: memoryMailEditions(s),
        mailAutomations: memoryMailAutomations(s),
        signinLinks: memorySigninLinks(s),
        readerSessions: memoryReaderSessions(s),
        operators: memoryOperators(store.operators),
        members: memoryMembers(s, store.operators, memberLock.lock),
        attentionReads: memoryAttentionReads(s),
        launchSteps: memoryLaunchSteps(s),
        apiKeys: memoryApiKeys(s),
        hostnames: memoryHostnames(store, s),
        jobs: new MemoryScheduler(store, tenantId, ids, clock),
        jobRecovery: new MemoryJobRecovery(store, tenantId, clock),
        usage: memoryUsage(s, clock),
        media: memoryMedia(s, mediaLock.lock),
        videos: memoryVideos(s),
        videoProvider: this.videoProvider,
        blobs: this.blobs,
        images: this.images,
        delivery: this.delivery,
        log: this.log,
        audit: memoryAudit(s),
        inputHasher: this.inputHasher,
        erasures: memoryErasures(store, principal, clock),
        personErasures: memoryPersonErasures(s, principal, clock),
        exports: memoryExports(s.exports),
      });
    } finally {
      bulkLock.release();
      memberLock.release();
      mediaLock.release();
      navigationLock.release();
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
