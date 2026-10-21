// The supporter module subscribes; other modules publish (ADR 003 rule 6). Ingest maps a domain
// event onto the inherited `wings.supporter-event.v1` envelope, dedups on its deterministic id,
// and updates the projection by applying the event, which equals a rebuild by construction.

import { z } from 'zod';
import { UseCaseError } from '../errors.js';
import type { NewsletterSubscribedProps } from '../forms/events.js';
import { systemPrincipal } from '../principal.js';
import type { DomainEvent, Subscriber, TransactionContext, UnitOfWork } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { sha1Hex } from '../util/digest.js';
import { SupporterEvent } from './events.js';
import { SupporterProjection, applyEvent } from './model.js';
import './ports.js';

export const SOURCE = 'mycel';

/** Build the envelope; `id` is sha1(source|source_ref|type|occurred_at) per the contract. */
export async function toSupporterEvent(event: DomainEvent): Promise<SupporterEvent> {
  if (event.type !== 'newsletter.subscribed')
    throw new Error(`no supporter mapping for event type ${event.type}`);
  const p = event.props as unknown as NewsletterSubscribedProps;
  const occurredAt = event.occurredAt.toISOString();
  const sourceRef = `submission:${p.submissionId}`;
  return SupporterEvent.parse({
    schema: 'wings.supporter-event.v1',
    id: await sha1Hex([SOURCE, sourceRef, event.type, occurredAt].join('|')),
    type: event.type,
    email: p.email,
    occurred_at: occurredAt,
    source: SOURCE,
    source_site: p.pageUrl ?? `urn:mycel:form:${p.formId}`,
    source_ref: sourceRef,
    props: {
      list: p.list,
      form_id: p.formId,
      locale: p.locale,
      consent_text_version: p.consentTextVersion,
      confirmed: p.confirmed,
    },
  });
}

export async function ingest(ctx: TransactionContext, event: SupporterEvent): Promise<boolean> {
  const inserted = await ctx.supporters.appendEvent(event);
  if (!inserted) return false;
  const current = await ctx.supporters.getProjection(event.email);
  await ctx.supporters.saveProjection(applyEvent(current, event));
  return true;
}

export function supporterIngestSubscriber(uow: UnitOfWork): Subscriber {
  return {
    name: 'supporters.ingest',
    types: ['newsletter.subscribed'],
    async handle(event) {
      const envelope = await toSupporterEvent(event);
      await uow.run(systemPrincipal(event.tenantId, 'supporters.ingest'), (ctx) =>
        ingest(ctx, envelope)
      );
    },
  };
}

export const getSupporter = defineUseCase({
  name: 'supporters.get',
  kind: 'query',
  description: 'Get the supporter projection (first seen, last activity, lists) by e-mail address.',
  requires: 'supporters:read',
  input: z.object({ email: z.string().trim().toLowerCase().email() }),
  output: SupporterProjection,
  resource: { uriTemplate: 'mycel://supporters/{email}' },
  examples: [{ input: { email: 'a@example.org' } }],
  async handler(ctx, { email }) {
    const projection = await ctx.supporters.getProjection(email);
    if (!projection) throw new UseCaseError('not_found', 'no supporter with that e-mail address');
    return projection;
  },
});
