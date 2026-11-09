// Confirmation events plan the existing durable connection intent. No second transport queue:
// pinned ids deduplicate outbox redelivery, and preparation rereads consent and erasure.
import type { Subscriber, TransactionContext, UnitOfWork } from '../../ports.js';
import { systemPrincipal } from '../../principal.js';
import { hashInput } from '../../audit/model.js';
import { ingest, toSupporterEvent } from '../../supporters/service.js';
import { connectionIntentGuard, planConnectionIntent } from '../../connections/intents.js';
import type { ConnectionSource } from '../../connections/ports.js';
import type { Submission } from '../model.js';
import { FORM_FEED_SOURCE, FormFeedPayload, type PinnedFormFeed } from './model.js';
import { feedAuthority, feedGate, mapFeed } from './rules.js';

export async function pinFormFeeds(ctx: TransactionContext, sub: Submission) {
  const state = await ctx.formFeeds.get();
  const pins: PinnedFormFeed[] = [];
  if (!state.actor || !(await feedAuthority(ctx, state.actor))) return pins;
  for (const feed of state.value.feeds) {
    if (feed.formId !== sub.formId || (await feedGate(ctx, feed)) || !mapFeed(sub, feed)) continue;
    pins.push({
      businessId: ctx.ids.next(),
      actor: state.actor,
      feed,
      version: await hashInput(ctx.inputHasher, {
        domain: 'form-feed-v1',
        tenantId: ctx.principal.tenantId,
        formVersion: sub.evaluation!.version,
        feed,
      }),
    });
  }
  return pins;
}
async function currentFeedAllowed(ctx: TransactionContext, pin: PinnedFormFeed) {
  const state = await ctx.formFeeds.get();
  const current = state.value.feeds.find((f) => f.id === pin.feed.id);
  // A changed mapping is not substituted. Disabling or removing the action revokes old work.
  return (
    !!current?.enabled &&
    current.formId === pin.feed.formId &&
    current.connectionId === pin.feed.connectionId &&
    current.connectionVersion === pin.feed.connectionVersion &&
    current.scope === pin.feed.scope &&
    (await feedAuthority(ctx, pin.actor)) &&
    !(await feedGate(ctx, pin.feed))
  );
}
export function formFeedSubscriber(uow: UnitOfWork): Subscriber {
  return {
    name: 'forms.feed',
    types: ['consent.given'],
    async handle(event) {
      const submissionId = event.props['submissionId'];
      if (typeof submissionId !== 'string') return;
      await uow.run(systemPrincipal(event.tenantId, 'forms.feed'), async (ctx) => {
        const sub = await ctx.submissions.findById(submissionId);
        if (!sub?.confirmedAt || !sub.evaluation?.feedActions?.length) return;
        const emailField = sub.evaluation.definition.fields.find((f) => f.type === 'email');
        const email = emailField && sub.values[emailField.name];
        if (
          typeof email !== 'string' ||
          email !== event.props['email'] ||
          sub.list !== event.props['list']
        )
          return;
        // Subscriber order is not a correctness dependency. Ingest is deterministic and idempotent.
        await ingest(ctx, await toSupporterEvent(event));
        const supporter = await ctx.supporters.getProjection(email);
        if (
          !supporter ||
          !supporter.lists.includes(sub.list) ||
          (await ctx.connectionIntents.erased(supporter.id))
        )
          return;
        for (const pin of sub.evaluation.feedActions) {
          if (!mapFeed(sub, pin.feed)) continue;
          await planConnectionIntent(
            ctx,
            {
              connectionId: pin.feed.connectionId!,
              businessId: pin.businessId,
              connectionVersion: pin.feed.connectionVersion!,
              source: FORM_FEED_SOURCE,
              mappingVersion: pin.version,
              supporterId: supporter.id,
              scope: pin.feed.scope,
            },
            { actor: pin.actor, retainBlocked: true }
          );
        }
      });
    },
  };
}
export const formFeedSource: ConnectionSource = {
  async prepare(ctx, intent) {
    if (intent.source !== FORM_FEED_SOURCE) return { ready: false, failure: 'source' };
    const failure = await connectionIntentGuard(ctx, intent);
    if (failure) return { ready: false, failure };
    const sub = await ctx.submissions.findByFeedBusinessId(intent.businessId);
    const pin = sub?.evaluation?.feedActions?.find((p) => p.businessId === intent.businessId);
    if (
      !sub?.confirmedAt ||
      !pin ||
      pin.version !== intent.mappingVersion ||
      pin.feed.connectionId !== intent.connectionId ||
      pin.feed.scope !== intent.scope ||
      pin.feed.connectionVersion !== intent.connectionVersion ||
      !(await currentFeedAllowed(ctx, pin))
    )
      return { ready: false, failure: 'source' };
    const supporter =
      intent.supporterId && (await ctx.supporters.getProjectionById(intent.supporterId));
    const emailField = sub.evaluation!.definition.fields.find((f) => f.type === 'email');
    if (!supporter || !emailField || supporter.email !== sub.values[emailField.name])
      return { ready: false, failure: 'erasure' };
    const history = await ctx.supporters.eventsFor(supporter.id);
    if (
      history.some(
        (e) =>
          ['consent.withdrawn', 'newsletter.unsubscribed'].includes(e.type) &&
          e.props['list'] === pin.feed.scope &&
          new Date(e.occurred_at) >= sub.createdAt
      )
    )
      return { ready: false, failure: 'consent' };
    const fields = mapFeed(sub, pin.feed);
    if (!fields) return { ready: false, failure: 'consent' };
    return {
      ready: true,
      payload: FormFeedPayload.parse({
        category: FORM_FEED_SOURCE,
        data: {
          submissionId: sub.id,
          formId: sub.formId,
          feedId: pin.feed.id,
          formVersion: sub.evaluation!.version,
          mappingVersion: pin.version,
          fields,
          consent: {
            scope: pin.feed.scope,
            owner: 'mycel',
            confirmedAt: sub.confirmedAt.toISOString(),
            textVersion: sub.consentTextVersion,
          },
        },
      }),
    };
  },
};
