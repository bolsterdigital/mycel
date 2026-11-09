// Registry authoring and effect-free rehearsal share the feed gate with the worker. Rejected:
// letting a caller mark an actual supporter confirmed as part of a test request.
import { z } from 'zod';
import { defineUseCase } from '../../registry.js';
import { can } from '../../principal.js';
import { notFound, UseCaseError } from '../../errors.js';
import { exampleId } from '../../util/ids.js';
import { evaluateFields } from '../fields.js';
import { RawValues } from '../model.js';
import { FormFeedSettings, FormFeedState } from './model.js';
import { feedAuthority, feedGate, mapFeed, validFeed } from './rules.js';
import { ConnectionFailure } from '../../connections/intents.js';

export const getFormFeeds = defineUseCase({
  name: 'form.feed.get',
  kind: 'query',
  requires: 'connections:read',
  description: 'Read private versioned form feeds and current destination availability.',
  input: z.object({}).strict(),
  output: z.object({
    state: FormFeedState,
    availability: z.array(
      z.object({
        id: z.string(),
        failure: ConnectionFailure.nullable(),
      })
    ),
  }),
  examples: [{ input: {} }],
  async handler(ctx) {
    const state = await ctx.formFeeds.get();
    return {
      state,
      availability: await Promise.all(
        state.value.feeds.map(async (f) => ({
          id: f.id,
          failure: (await feedAuthority(ctx, state.actor))
            ? await feedGate(ctx, f)
            : ('authorization' as const),
        }))
      ),
    };
  },
});
export const updateFormFeeds = defineUseCase({
  name: 'form.feed.update',
  kind: 'command',
  requires: 'connections:configure',
  description: 'Configure versioned form feeds; activation also requires publishing permission.',
  input: z
    .object({ baseVersion: z.number().int().nonnegative(), value: FormFeedSettings })
    .strict(),
  output: FormFeedState,
  examples: [{ input: { baseVersion: 0, value: { feeds: [] } } }],
  async handler(ctx, { baseVersion, value }) {
    if (value.feeds.some((f) => f.enabled) && !can(ctx.principal, 'content:publish'))
      throw new UseCaseError('forbidden', 'feed activation requires publishing permission');
    for (const feed of value.feeds) {
      const form = await ctx.forms.findById(feed.formId);
      if (!form) throw notFound('form');
      if (!validFeed(form, feed))
        throw new UseCaseError('invalid_input', 'invalid feed mapping or scope');
      if (feed.connectionId) {
        const c = await ctx.connections.get(feed.connectionId);
        if (!c) throw notFound('connection');
        if (
          c.version !== feed.connectionVersion ||
          !c.formIds.includes(form.id) ||
          !c.consentScopes.includes(feed.scope) ||
          c.consentAuthority !== 'mycel'
        )
          throw new UseCaseError('invalid_input', 'connection does not authorize this feed');
      } else if (feed.enabled || feed.connectionVersion !== null)
        throw new UseCaseError('invalid_input', 'an unconnected feed must be disabled');
    }
    const a = ctx.principal.actor;
    if (a.kind === 'anonymous') throw new UseCaseError('forbidden', 'authentication required');
    const actor =
      a.kind === 'operator'
        ? { kind: 'operator' as const, id: a.operatorId }
        : a.kind === 'system'
          ? { kind: 'system' as const, id: a.job }
          : { kind: 'api-key' as const, id: a.keyId };
    const saved = await ctx.formFeeds.save(baseVersion, value, actor);
    if (!saved) throw new UseCaseError('conflict', 'feed settings changed');
    return saved;
  },
});
export const testFormFeed = defineUseCase({
  name: 'form.feed.test',
  kind: 'query',
  requires: 'connections:configure',
  description:
    'Evaluate synthetic field values against a feed without sending or recording consent.',
  input: z
    .object({ feedId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), values: RawValues })
    .strict(),
  output: z.object({
    matches: z.boolean(),
    failure: ConnectionFailure.nullable(),
    fields: RawValues,
    requiresConfirmation: z.literal(true),
  }),
  examples: [{ input: { feedId: 'news', values: { email: 'test@example.org', consent: true } } }],
  async handler(ctx, input) {
    const state = await ctx.formFeeds.get();
    const feed = state.value.feeds.find((f) => f.id === input.feedId);
    if (!feed) throw notFound('feed');
    const form = await ctx.forms.findById(feed.formId);
    if (!form) throw notFound('form');
    const evaluated = evaluateFields(form.fields, input.values);
    if (evaluated.errors.length)
      throw new UseCaseError('invalid_input', 'invalid synthetic values');
    const failure = !(await feedAuthority(ctx, state.actor))
      ? ('authorization' as const)
      : await feedGate(ctx, feed);
    const fields = mapFeed(
      {
        id: exampleId(1),
        formId: form.id,
        values: evaluated.values,
        locale: 'en',
        pageUrl: null,
        ipHash: null,
        createdAt: ctx.clock.now(),
        confirmedAt: null,
        list: form.list,
        consentTextVersion: form.consentTextVersion,
        evaluation: {
          version: 'synthetic',
          definition: form,
          activeFieldIds: evaluated.activeFieldIds,
          requiredFieldIds: evaluated.requiredFieldIds,
          discardedFieldIds: evaluated.discardedFieldIds,
        },
      },
      feed
    );
    return {
      matches: !failure && fields !== null,
      failure,
      fields: fields ?? {},
      requiresConfirmation: true as const,
    };
  },
});
