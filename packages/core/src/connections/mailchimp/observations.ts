// Only a new, provider-dated confirmation of this submission grants local consent. Historic
// subscribed status is evidence of an external copy, not of this visitor's confirmation.
//
// The two halves need different evidence. Granting consent needs the submission (its pinned
// feed, its consent text, its own confirmation), so without it nothing is granted. Removing
// permission must keep working after the submission passed its retention term: a withdrawal at
// the provider is then applied from the receipt (whose member hash is the submitted address),
// the intent and the supporter that still holds that address. Rejected: keeping every fed
// submission while its intent exists (that lifts the term for every Mailchimp-fed supporter),
// and ending the comparison with the submission (a provider-side unsubscribe would never reach
// local consent again).
import type { TransactionContext } from '../../ports.js';
import type { ConnectionIntent } from '../intents.js';
import type { MailchimpMemberStatus, MailchimpReceipt } from './ports.js';
import type { SupporterProjection } from '../../supporters/model.js';
import { ingest, toSupporterEvent, type WithdrawalEvidence } from '../../supporters/service.js';
import { formFeedSource } from '../../forms/feed/delivery.js';

const SUPPRESSED = ['unsubscribed', 'cleaned', 'archived', 'absent'];

export interface MailchimpObservation {
  status: MailchimpMemberStatus | 'absent';
  changedAt: Date;
  optAt: Date | null;
  /** The provider's member hash of an address; the receipt holds it for the submitted one. */
  memberHash(email: string): string;
}

/**
 * Event time is observation time; the causal id sorts after the projection at equal precision,
 * so a same-millisecond confirmation cannot undo the observed suppression. Returns whether the
 * withdrawal was appended.
 */
async function suppress(
  ctx: TransactionContext,
  intent: ConnectionIntent,
  supporter: SupporterProjection,
  at: { now: Date; id: string },
  evidence: { lifecycleId: string | undefined; proof: WithdrawalEvidence } | null
): Promise<boolean> {
  const { now, id } = at;
  return ingest(
    ctx,
    {
      schema: 'wings.supporter-event.v1',
      id: `${supporter.appliedThrough.id}:mailchimp:${id}`,
      type: 'newsletter.unsubscribed',
      email: supporter.email,
      occurred_at: now.toISOString(),
      ...(evidence?.lifecycleId ? { lifecycle_id: evidence.lifecycleId } : {}),
      source: 'mailchimp',
      source_site: 'urn:mycel:connection:' + intent.connectionId,
      source_ref: intent.id,
      props: { list: intent.scope, connectionId: intent.connectionId },
    },
    evidence?.proof
  );
}

const published = (
  ctx: TransactionContext,
  intent: ConnectionIntent,
  email: string,
  at: { now: Date; id: string }
) =>
  ctx.events.publish({
    id: at.id,
    type: 'newsletter.unsubscribed',
    tenantId: ctx.principal.tenantId,
    occurredAt: at.now,
    actor: ctx.principal.actor,
    props: { email, list: intent.scope, connectionId: intent.connectionId },
  });

/**
 * The submission is gone (retention). Only a withdrawal can still be applied, and only to the
 * supporter the receipt was written for while it holds the address the member hash was made of.
 * For an address that was erased and signed up again, the supporter is its readmitted lifecycle
 * and `ingest` takes the receipt of that lifecycle as the evidence (ADR 032 rule 3), so retention
 * need not keep the submission.
 */
async function applyWithoutSubmission(
  ctx: TransactionContext,
  intent: ConnectionIntent,
  receipt: MailchimpReceipt,
  observation: MailchimpObservation
) {
  const before = await ctx.supporters.getProjectionById(intent.supporterId!);
  if (!before) return;
  // Hold the address through ingest, then reread: an address change during provider I/O must
  // not suppress the new address.
  await ctx.supporters.lock(before.email);
  const supporter = await ctx.supporters.getProjectionById(before.id);
  if (
    !supporter ||
    supporter.email !== before.email ||
    observation.memberHash(supporter.email) !== receipt.memberHash ||
    (await ctx.connectionIntents.erased(supporter.id)) ||
    (await ctx.supporters.getProjection(supporter.email))?.id !== supporter.id
  )
    return;
  const now = ctx.clock.now();
  if (SUPPRESSED.includes(observation.status) && supporter.lists.includes(intent.scope)) {
    const at = { now, id: ctx.ids.next() };
    // A registered address is only usable as its live lifecycle; `ingest` checks that it is one.
    const evidence = (await ctx.erasures.allows(supporter.email))
      ? null
      : {
          lifecycleId: supporter.id,
          proof: { receiptIntentId: intent.id, memberHash: observation.memberHash },
        };
    if (await suppress(ctx, intent, supporter, at, evidence))
      await published(ctx, intent, supporter.email, at);
  }
  await ctx.mailchimpReceipts.observe(intent.id, observation.status, now, receipt.confirmedAt);
}

export async function applyMailchimpObservation(
  ctx: TransactionContext,
  intent: ConnectionIntent,
  observation: MailchimpObservation
) {
  const receipt = await ctx.mailchimpReceipts.get(intent.id);
  if (
    !receipt ||
    !intent.supporterId ||
    receipt.supporterId !== intent.supporterId ||
    receipt.connectionId !== intent.connectionId
  )
    return;
  const sub = await ctx.submissions.findByFeedBusinessId(intent.businessId);
  if (!sub) return applyWithoutSubmission(ctx, intent, receipt, observation);
  const pin = sub.evaluation?.feedActions?.find((p) => p.businessId === intent.businessId);
  if (!pin) return;
  const emailField = sub.evaluation!.definition.fields.find((f) => f.type === 'email');
  const email = emailField && sub.values[emailField.name];
  if (typeof email !== 'string') return;
  // The receipt's member belongs to the submitted address. Hold that address through ingest,
  // then reread: an address change during provider I/O must not suppress the new address.
  // This identity check is independent of marketing authorization, so withdrawals still apply.
  await ctx.supporters.lock(email);
  const supporter = await ctx.supporters.getProjectionById(intent.supporterId);
  if (!supporter || supporter.email !== email || (await ctx.connectionIntents.erased(supporter.id)))
    return;
  const now = ctx.clock.now();
  const suppressed = SUPPRESSED.includes(observation.status);
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
          supporterLifecycleId: sub.evaluation?.supporterLifecycleId,
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
    const at = { now, id: ctx.ids.next() };
    await suppress(ctx, intent, supporter, at, {
      lifecycleId: sub.evaluation?.supporterLifecycleId,
      proof: { submissionId: sub.id },
    });
    await published(ctx, intent, supporter.email, at);
  }
  await ctx.mailchimpReceipts.observe(intent.id, observation.status, now, confirmedAt);
}
