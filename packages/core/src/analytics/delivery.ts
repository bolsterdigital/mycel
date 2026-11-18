// The analytics subscriber (docs/reference/analytics.md § Server events): turns one committed
// `analytics.intent` into at most one `AnalyticsDelivery` on the `Analytics` port, after the form
// that caused it has answered. Delivery is at most once: a claim on the event id is committed
// before anything is sent, so a redelivered outbox event, a crashed drain or a second worker sends
// nothing. A count is best-effort, so losing one to a crash between the claim and the send is the
// accepted side of that trade; counting one twice is not, because the Events API has no
// idempotency key. The subscriber never throws after the claim: the outbox then marks the event
// handled and never retries it.
// Rejected: retrying through the outbox's own backoff (each retry is a blind resend of a request
// that may have arrived, and ten failed passes leave a dead row for an operator to look at) and a
// delivery table of our own (Mycel keeps no analytics history; the claim lives in the rate-limit
// windows the hourly sweep already empties after a day).

import type { Clock, DomainEvent, Logger, Subscriber, UnitOfWork } from '../ports.js';
import { systemPrincipal } from '../principal.js';
import '../forms/ports.js';
import '../tenants/ports.js';
import { MAX_COOLDOWN_SECONDS } from '../forms/ports.js';
import type { PlatformConfig, TenantDirectory } from '../tenants/ports.js';
import { siteUrl } from '../tenants/url.js';
import { ANALYTICS_INTENT } from './events.js';
import { AnalyticsDelivery, AnalyticsEvent } from './model.js';
import type { Analytics, AnalyticsOutcome } from './ports.js';

export const ANALYTICS_SUBSCRIBER = 'analytics.delivery';

/**
 * How old an intent may be when it is sent. A count that arrives later than this would be dated
 * wrongly in Plausible, which dates an event on receipt; a worker that was down longer drops it.
 * Far below the claim's lifetime (`MAX_COOLDOWN_SECONDS`), so a claim never expires while its
 * event can still be delivered.
 */
export const ANALYTICS_DELIVERY_WINDOW_MS = 60 * 60 * 1000;

/** What became of one intent, as logged: a transport outcome or why nothing was sent. */
export type AnalyticsResult =
  AnalyticsOutcome | 'off' | 'duplicate' | 'expired' | 'malformed' | 'no-tenant';

export interface AnalyticsDeliveryDeps {
  uow: UnitOfWork;
  tenants: TenantDirectory;
  /** The site root is `siteUrl(tenant, '/')`, on the primary hostname (ADR 014 rule 6). */
  platform: Pick<PlatformConfig, 'platformOrigin' | 'siteUrlMode'>;
  /** `NoopAnalytics` until the Plausible transport is configured. */
  analytics: Analytics;
  clock: Clock;
  log: Logger;
}

/**
 * Send once, and once more only when the transport says nothing left (`retryable`). A transport
 * that throws may have sent: that is `unknown`, never retried.
 */
async function sendBounded(
  analytics: Analytics,
  delivery: AnalyticsDelivery
): Promise<AnalyticsOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    let outcome: AnalyticsOutcome;
    try {
      outcome = await analytics.send(delivery);
    } catch {
      return 'unknown';
    }
    if (outcome !== 'retryable' || attempt === 2) return outcome;
  }
}

/** Deliver one intent; exported for tests, which assert the result as well as what was sent. */
export async function deliverAnalyticsIntent(
  deps: AnalyticsDeliveryDeps,
  event: DomainEvent
): Promise<AnalyticsResult> {
  const parsed = AnalyticsEvent.safeParse(event.props);
  if (!parsed.success) return 'malformed';
  if (deps.clock.now().getTime() - event.occurredAt.getTime() > ANALYTICS_DELIVERY_WINDOW_MS)
    return 'expired';
  const tenant = await deps.tenants.findById(event.tenantId);
  if (!tenant) return 'no-tenant';

  // The setting is read now, not at submit time: clearing it stops what is still queued. The
  // claim commits with this transaction, before the send.
  const plan = await deps.uow.run(
    systemPrincipal(event.tenantId, ANALYTICS_SUBSCRIBER),
    async (ctx) => {
      const domain = (await ctx.analyticsSettings.get()).value.plausibleDomain;
      if (!domain) return 'off' as const;
      const claimed = await ctx.rateLimits.cooldown(
        `${ANALYTICS_SUBSCRIBER}:${event.id}`,
        MAX_COOLDOWN_SECONDS
      );
      if (!claimed) return 'duplicate' as const;
      return { domain, primaryHostname: (await ctx.hostnames.primary())?.hostname ?? null };
    }
  );
  if (typeof plan === 'string') return plan;

  const delivery = AnalyticsDelivery.safeParse({
    domain: plan.domain,
    url: siteUrl({ slug: tenant.slug, primaryHostname: plan.primaryHostname }, deps.platform, '/'),
    event: parsed.data,
  });
  if (!delivery.success) return 'malformed';
  return sendBounded(deps.analytics, delivery.data);
}

/**
 * The outbox subscriber. Logs one line per intent with the event name and the result, never the
 * site identifier, a URL or the provider's answer; `unknown` is a warning, because it is the
 * outcome an operator may want to look at.
 */
export function analyticsSubscriber(deps: AnalyticsDeliveryDeps): Subscriber {
  return {
    name: ANALYTICS_SUBSCRIBER,
    types: [ANALYTICS_INTENT],
    async handle(event) {
      const result = await deliverAnalyticsIntent(deps, event);
      const fields = {
        tenantId: event.tenantId,
        eventId: event.id,
        // Only a catalogue name is logged; a malformed intent logs none of its props.
        name: AnalyticsEvent.safeParse(event.props).data?.name ?? null,
        result,
      };
      if (result === 'unknown' || result === 'malformed' || result === 'no-tenant')
        deps.log.warn('analytics.delivery', fields);
      else deps.log.info('analytics.delivery', fields);
    },
  };
}
