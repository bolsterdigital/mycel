// The supporter module subscribes; other modules publish (ADR 003 rule 6). Ingest maps a domain
// event onto the inherited `wings.supporter-event.v1` envelope, resolves the e-mail address to a
// stable supporter id under a per-address lock, dedups on the deterministic event id, and folds
// the event into the projection (ADR 019 rules 1 to 3).

import { z } from 'zod';
import { notFound, UseCaseError } from '../errors.js';
import type { ConsentGivenProps, NewsletterSubscribedProps } from '../forms/events.js';
import { systemPrincipal } from '../principal.js';
import type { DomainEvent, Subscriber, TransactionContext, UnitOfWork } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { sha1Hex } from '../util/digest.js';
import { SupporterEvent } from './events.js';
import {
  SupporterProjection,
  applyEvent,
  compareFoldPosition,
  foldPosition,
  rebuildProjection,
} from './model.js';
import './ports.js';
import { exampleId } from '../util/ids.js';

export const SOURCE = 'mycel';

/**
 * Build the envelope; `id` is sha1(source|source_ref|type|occurred_at) per the contract. The
 * signup and its confirmation share `source_ref` (the submission) and differ in type, so both
 * ids are deterministic and distinct.
 */
export async function toSupporterEvent(event: DomainEvent): Promise<SupporterEvent> {
  const occurredAt = event.occurredAt.toISOString();
  const envelope = async (
    p: { email: string; submissionId: string; formId: string },
    sourceSite: string,
    props: Record<string, unknown>
  ) => {
    const sourceRef = `submission:${p.submissionId}`;
    return SupporterEvent.parse({
      schema: 'wings.supporter-event.v1',
      id: await sha1Hex([SOURCE, sourceRef, event.type, occurredAt].join('|')),
      type: event.type,
      email: p.email,
      occurred_at: occurredAt,
      source: SOURCE,
      source_site: sourceSite,
      source_ref: sourceRef,
      props: { form_id: p.formId, ...props },
    });
  };
  if (event.type === 'newsletter.subscribed') {
    const p = event.props as unknown as NewsletterSubscribedProps;
    return envelope(p, p.pageUrl ?? `urn:mycel:form:${p.formId}`, {
      list: p.list,
      locale: p.locale,
      consent_text_version: p.consentTextVersion,
      confirmed: p.confirmed,
    });
  }
  if (event.type === 'consent.given') {
    const p = event.props as unknown as ConsentGivenProps;
    return envelope(p, `urn:mycel:form:${p.formId}`, {
      list: p.list,
      locale: p.locale,
      consent_text_version: p.consentTextVersion,
    });
  }
  throw new Error(`no supporter mapping for event type ${event.type}`);
}

/**
 * Ingest one envelope. Locks the address first, so two workers on one supporter serialise and
 * different supporters run in parallel (ADR 019 rule 3); `supporter_id` on the input is ignored,
 * the address decides. After a `supporter.email_changed` the old address no longer resolves, so an
 * event that still uses it starts a new supporter: the source has to use the new address.
 */
export async function ingest(ctx: TransactionContext, event: SupporterEvent): Promise<boolean> {
  await ctx.supporters.lock(event.email);
  const { id } = await ctx.supporters.resolve(event.email);
  const appended = await appendAndFold(ctx, { ...event, supporter_id: id });
  // The projection exists now (or did already): the seat `form.submit` reserved is taken by it,
  // in this same transaction, so the address is never counted twice (TODO #16). Under the
  // admission lock, after the address lock (always in that order, so no deadlock): a submit
  // that is between its projection check and its reservation finishes first, and the release
  // below then removes what it reserved.
  await ctx.admissions.lock();
  await ctx.admissions.release(event.email);
  return appended;
}

/** Append, then fold: on top when the event is newest, from the log when it arrived late. */
async function appendAndFold(
  ctx: TransactionContext,
  event: SupporterEvent & { supporter_id: string }
): Promise<boolean> {
  if (!(await ctx.supporters.appendEvent(event))) return false;
  const current = await ctx.supporters.getProjectionById(event.supporter_id);
  const next =
    current && compareFoldPosition(foldPosition(event), current.appliedThrough) > 0
      ? applyEvent(current, event)
      : rebuildProjection(await ctx.supporters.eventsFor(event.supporter_id));
  if (!next) throw new Error(`supporter ${event.supporter_id} has no events after an append`);
  await ctx.supporters.saveProjection(next);
  return true;
}

export function supporterIngestSubscriber(uow: UnitOfWork): Subscriber {
  return {
    name: 'supporters.ingest',
    types: ['newsletter.subscribed', 'consent.given'],
    async handle(event) {
      const envelope = await toSupporterEvent(event);
      await uow.run(systemPrincipal(event.tenantId, 'supporters.ingest'), (ctx) =>
        ingest(ctx, envelope)
      );
    },
  };
}

export const getSupporter = defineUseCase({
  name: 'supporter.get',
  kind: 'query',
  description:
    'Get the supporter projection (id, first seen, last activity, confirmed and pending lists) by e-mail address.',
  requires: 'supporters:read',
  input: z.object({ email: z.string().trim().toLowerCase().email() }),
  output: SupporterProjection,
  resource: { uriTemplate: 'mycel://supporters/{email}' },
  examples: [{ input: { email: 'a@example.org' } }],
  async handler(ctx, { email }) {
    const projection = await ctx.supporters.getProjection(email);
    if (!projection) throw notFound('supporter', 'that e-mail address');
    return projection;
  },
});

export const changeSupporterEmail = defineUseCase({
  name: 'supporter.email.update',
  kind: 'command',
  description:
    'Change the e-mail address of a supporter; the change is a logged event, never an overwrite.',
  requires: 'supporters:write',
  input: z.object({
    supporterId: z.string().guid(),
    newEmail: z.string().trim().toLowerCase().email(),
    /** Evidence for the change (ADR 019 rule 1): who asked, through which channel. */
    reason: z.string().trim().min(1).max(500),
  }),
  output: SupporterProjection,
  examples: [
    {
      input: {
        supporterId: exampleId(0x1),
        newEmail: 'new@example.org',
        reason: 'Requested by the supporter by e-mail.',
      },
    },
  ],
  async handler(ctx, { supporterId, newEmail, reason }) {
    const before = await ctx.supporters.getProjectionById(supporterId);
    if (!before) throw notFound('supporter');
    if (before.email === newEmail) return before;

    // Both addresses, in a fixed order so two opposite changes cannot deadlock. The read above
    // was unlocked: if the address moved in between, the caller retries on fresh data.
    for (const email of [before.email, newEmail].sort()) await ctx.supporters.lock(email);
    const current = await ctx.supporters.getProjectionById(supporterId);
    if (!current || current.email !== before.email)
      throw new UseCaseError('conflict', 'the supporter changed while the request ran; retry');
    const holder = await ctx.supporters.getProjection(newEmail);
    if (holder) throw new UseCaseError('conflict', 'another supporter has that e-mail address');

    const occurredAt = ctx.clock.now().toISOString();
    const sourceRef = `supporter:${supporterId}`;
    const type = 'supporter.email_changed';
    const appended = await appendAndFold(ctx, {
      ...SupporterEvent.parse({
        schema: 'wings.supporter-event.v1',
        id: await sha1Hex([SOURCE, sourceRef, type, occurredAt].join('|')),
        type,
        email: current.email,
        occurred_at: occurredAt,
        source: SOURCE,
        source_site: 'urn:mycel:supporters',
        source_ref: sourceRef,
        props: { old_email: current.email, new_email: newEmail, reason },
      }),
      supporter_id: supporterId,
    });
    // Same supporter, same millisecond: the deterministic id collides with an earlier change.
    if (!appended) throw new UseCaseError('conflict', 'a change was just recorded; retry');
    const after = await ctx.supporters.getProjectionById(supporterId);
    if (!after) throw new Error(`supporter ${supporterId} vanished during an e-mail change`);
    return after;
  },
});
