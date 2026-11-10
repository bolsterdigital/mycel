// Only a new, provider-dated confirmation of this submission grants local consent. Historic
// subscribed status is evidence of an external copy, not of this visitor's confirmation.
import type { TransactionContext } from '../../ports.js';
import type { ConnectionIntent } from '../intents.js';
import type { MailchimpMemberStatus } from './ports.js';
import { ingest, toSupporterEvent } from '../../supporters/service.js';
import { formFeedSource } from '../../forms/feed/delivery.js';

export async function applyMailchimpObservation(
  ctx: TransactionContext,
  intent: ConnectionIntent,
  observation: { status: MailchimpMemberStatus | 'absent'; changedAt: Date; optAt: Date | null }
) {
  const receipt = await ctx.mailchimpReceipts.get(intent.id);
  const sub = await ctx.submissions.findByFeedBusinessId(intent.businessId);
  const pin = sub?.evaluation?.feedActions?.find((p) => p.businessId === intent.businessId);
  if (!receipt || !sub || !pin || !intent.supporterId) return;
  const supporter = await ctx.supporters.getProjectionById(intent.supporterId);
  if (!supporter || (await ctx.connectionIntents.erased(supporter.id))) return;
  const now = ctx.clock.now();
  const suppressed = ['unsubscribed', 'cleaned', 'archived', 'absent'].includes(observation.status);
  const external = pin.feed.confirmationOwner === 'external';
  const freshConfirmation =
    external &&
    observation.status === 'subscribed' &&
    pin.feed.operation !== 'profile' &&
    (receipt.baselineStatus === 'absent' ||
      (receipt.baselineStatus === 'unsubscribed' &&
        pin.feed.operation === 'resubscribe' &&
        receipt.baselineChangedAt &&
        sub.createdAt > receipt.baselineChangedAt)) &&
    observation.optAt &&
    observation.optAt >= receipt.requestedAt &&
    observation.optAt <= now &&
    observation.changedAt >= receipt.requestedAt;
  const authorized = (await formFeedSource.prepare(ctx, intent)).ready;
  let confirmedAt = receipt.confirmedAt;
  if (freshConfirmation && authorized && !sub.confirmedAt) {
    if (await ctx.submissions.confirm(sub.id, observation.optAt!)) {
      confirmedAt = observation.optAt!;
      const event = {
        id: ctx.ids.next(),
        type: 'consent.given',
        tenantId: ctx.principal.tenantId,
        occurredAt: confirmedAt,
        actor: ctx.principal.actor,
        props: {
          email: supporter.email,
          list: sub.list,
          submissionId: sub.id,
          formId: sub.formId,
          locale: sub.locale,
          consentTextVersion: sub.consentTextVersion,
          confirmedAt: confirmedAt.toISOString(),
          confirmationOwner: 'external',
          connectionId: intent.connectionId,
        },
      };
      await ingest(ctx, await toSupporterEvent(event));
      await ctx.events.publish(event);
    }
  }
  if (suppressed && supporter.lists.includes(intent.scope)) {
    // Event time is observation time; the causal id sorts after the projection at equal
    // precision, so a same-millisecond confirmation cannot undo the observed suppression.
    const event = {
      id: ctx.ids.next(),
      type: 'newsletter.unsubscribed',
      tenantId: ctx.principal.tenantId,
      occurredAt: now,
      actor: ctx.principal.actor,
      props: { email: supporter.email, list: intent.scope, connectionId: intent.connectionId },
    };
    await ingest(ctx, {
      schema: 'wings.supporter-event.v1',
      id: `${supporter.appliedThrough.id}:mailchimp:${event.id}`,
      type: 'newsletter.unsubscribed',
      email: supporter.email,
      occurred_at: now.toISOString(),
      source: 'mailchimp',
      source_site: 'urn:mycel:connection:' + intent.connectionId,
      source_ref: intent.id,
      props: { list: intent.scope, connectionId: intent.connectionId },
    });
    await ctx.events.publish(event);
  }
  await ctx.mailchimpReceipts.observe(intent.id, observation.status, now, confirmedAt);
}
