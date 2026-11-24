// Fetch outside the tenant transaction. A claim records the attempt before opening a socket;
// the old snapshot can survive a temporary failure only until its original expiry.
import {
  systemPrincipal,
  type Clock,
  type IdentityStore,
  type Principal,
  type SocialProfiles,
  type UnitOfWork,
} from '@mycel/core';
import {
  conversationCache,
  publishedConversationLinks,
  withTenant,
  type createDb,
} from '@mycel/db';
import { requestCounts } from './providers.js';
import type { PublicJson } from './public-json.js';
import {
  socialTarget,
  type ConversationProviders,
  type SocialCounts,
  type SocialTarget,
} from './targets.js';

const HOUR = 60 * 60 * 1000;
const MIN_REFRESH_MS = 50 * 60 * 1000; // Leave room for small differences in hourly job start times.
const LIFETIME_MS = 2 * HOUR;
const MAX_PER_TENANT = 8;

interface Dependencies {
  db: ReturnType<typeof createDb>;
  uow: UnitOfWork;
  identity: Pick<IdentityStore, 'tenantAccess'>;
  clock: Clock;
  providers: ConversationProviders;
  get: PublicJson;
}

export function conversationService({ db, uow, identity, clock, providers, get }: Dependencies) {
  const enabled = providers.bluesky || providers.mastodon.size > 0;
  return {
    enabled,
    async read(
      reader: Principal,
      profiles: SocialProfiles | undefined,
      hrefs: readonly string[]
    ): Promise<Map<string, SocialCounts>> {
      const targets = new Map<string, SocialTarget>();
      for (const href of hrefs) {
        const target = socialTarget(href, profiles, providers);
        if (target) targets.set(href, target);
      }
      if (!targets.size) return new Map();
      const cached = await withTenant(db, reader, (trx) =>
        conversationCache(trx, reader.tenantId).read([...targets.values()], clock.now())
      );
      const result = new Map<string, SocialCounts>();
      for (const [href, target] of targets) {
        const counts = cached.get(target.key);
        if (counts && (counts.replies !== undefined || counts.reposts !== undefined))
          result.set(href, counts);
      }
      return result;
    },

    async refresh(tenantId: string): Promise<void> {
      if (!enabled) return;
      const access = await identity.tenantAccess(tenantId);
      if (access.status !== 'active' || access.entitlements.blocks['social-conversation'] === false)
        return;
      const principal = systemPrincipal(tenantId, 'jobs:social-conversation.refresh', access);
      const { value: chrome } = await uow.run(principal, (ctx) => ctx.siteSettings.chrome());
      const claims = await withTenant(db, principal, async (trx) => {
        const cache = conversationCache(trx, tenantId);
        const now = clock.now();
        await cache.prune(new Date(now.getTime() - 24 * HOUR));
        if (!chrome.social) return { claimed: [], checkedAt: now };
        const order = await cache.refreshOrder();
        const targets = new Map<string, SocialTarget>();
        for (const href of await publishedConversationLinks(trx)) {
          const target = socialTarget(href, chrome.social, providers);
          if (target) targets.set(target.key, target);
        }
        const last = ({ key }: SocialTarget) => order.get(key) ?? 0;
        const before = new Date(now.getTime() - MIN_REFRESH_MS);
        const due = [...targets.values()]
          .filter((target) => last(target) <= before.getTime())
          .sort((a, b) => last(a) - last(b))
          .slice(0, MAX_PER_TENANT);
        const claimed: SocialTarget[] = [];
        for (const target of due) {
          if (await cache.claim(target, now, before)) claimed.push(target);
        }
        return { claimed, checkedAt: now };
      });
      // The bounded batch starts together, directly after reading the publication pointers.
      await Promise.all(
        claims.claimed.map(async (target) => {
          const result = await requestCounts(target, get);
          if (result.kind === 'unavailable') return;
          const expiresAt =
            result.kind === 'public' ? new Date(claims.checkedAt.getTime() + LIFETIME_MS) : null;
          await withTenant(db, principal, (trx) =>
            conversationCache(trx, tenantId).finish(
              target,
              claims.checkedAt,
              result.kind === 'public' ? result.counts : {},
              expiresAt
            )
          );
        })
      );
    },
  };
}
