// The analytics intent: how a use case asks for one catalogue event to be counted (docs/reference/
// analytics.md § Server events). It is its own outbox type whose props are exactly an
// `AnalyticsEvent`, published in the transaction that made the fact true, so a rollback takes the
// count with it and the subscriber never reads another module's rows or props.
// Rejected: deriving the count from `newsletter.subscribed` (published only with ticked consent,
// and it carries the address, list and submission id the provider must never see) and from the
// confirmation-time `form.submitted` domain event (a confirmation is not the accepted submission
// the catalogue counts, and it also carries the address).

import type { TransactionContext } from '../ports.js';
import './ports.js';
import { AnalyticsEvent } from './model.js';

/** The outbox type of an analytics intent; its props are one `AnalyticsEvent`, nothing else. */
export const ANALYTICS_INTENT = 'analytics.intent';

/**
 * Publish `event` for counting when the site measures; a site without a Plausible site stores
 * nothing. Only an anonymous visitor's action counts (a public signup, not an integration's import),
 * and the stored actor keeps the channel without the IP hash: the intent identifies nobody.
 * Returns whether an intent was published.
 */
export async function countForAnalytics(
  ctx: TransactionContext,
  event: AnalyticsEvent
): Promise<boolean> {
  const { actor, tenantId } = ctx.principal;
  if (actor.kind !== 'anonymous') return false;
  if (!(await ctx.analyticsSettings.get()).value.plausibleDomain) return false;
  await ctx.events.publish({
    id: ctx.ids.next(),
    type: ANALYTICS_INTENT,
    tenantId,
    occurredAt: ctx.clock.now(),
    actor: { kind: 'anonymous', channel: actor.channel },
    props: AnalyticsEvent.parse(event),
  });
  return true;
}
