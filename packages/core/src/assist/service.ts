// A suggestion is a proposal, never a content write. The request transaction checks consent,
// quota and the revision, then queues a worker; only an operator's later acceptance writes a
// revision. Rejected: calling a provider from a use case, which holds an RLS transaction open.

import { z } from 'zod';
import { ContentDocument } from '../content/model.js';
import { assertBase, lockItem, writeRevision } from '../content/service.js';
import { UseCaseError } from '../errors.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { jobKey } from '../jobs/types.js';
import { AltResult, SettingsView, SuggestionView } from './model.js';
import type { AssistSettings, AssistSuggestion } from './ports.js';
import './ports.js';

const uuid = z.string().guid();
const exampleId = '01900000-0000-7000-8000-000000000001';
const iso = (date: Date | null) => date?.toISOString() ?? null;
const settingsView = (settings: AssistSettings, provider: string | null) => ({
  ...settings,
  consentedAt: iso(settings.consentedAt),
  provider,
});
const suggestionView = (s: AssistSuggestion, now: Date) => ({
  ...s,
  status:
    s.status === 'pending' && now.getTime() - s.createdAt.getTime() > 600_000
      ? ('failed' as const)
      : s.status,
  failure:
    s.status === 'pending' && now.getTime() - s.createdAt.getTime() > 600_000
      ? ('timeout' as const)
      : s.failure,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});
const refuse = (code: 'invalid_input' | 'limit_exceeded' | 'conflict', issue: string): never => {
  throw new UseCaseError(code, issue, [{ path: '', message: `assist.error.${issue}` }]);
};
const findSuggestion = async (ctx: TransactionContext, id: string): Promise<AssistSuggestion> => {
  const row = await ctx.assist.get(id);
  if (!row) throw new UseCaseError('not_found', 'suggestion not found');
  return row;
};

export const getAssistSettings = defineUseCase({
  name: 'assist.settings.get',
  kind: 'query',
  description: 'Read this site’s assistance consent and configured processor.',
  requires: 'content:read',
  authenticatedOnly: true,
  input: z.object({}).strict(),
  output: SettingsView,
  examples: [{ input: {} }],
  async handler(ctx) {
    return settingsView(await ctx.assist.settings(), ctx.assistProviderLabel);
  },
});

export const updateAssistSettings = defineUseCase({
  name: 'assist.settings.update',
  kind: 'command',
  description: 'Enable assistance for a named processor and set the restricted-content choice.',
  requires: 'tenant:admin',
  authenticatedOnly: true,
  actors: ['operator'],
  input: z
    .object({
      enabled: z.boolean(),
      allowRestricted: z.boolean(),
      consentedProvider: z.string().min(1).nullable(),
    })
    .strict(),
  output: SettingsView,
  examples: [{ input: { enabled: false, allowRestricted: false, consentedProvider: null } }],
  async handler(ctx, input) {
    if (
      input.enabled &&
      (!ctx.assistProviderLabel || input.consentedProvider !== ctx.assistProviderLabel)
    )
      refuse('invalid_input', 'consent-required');
    const consented = input.enabled && input.consentedProvider === ctx.assistProviderLabel;
    const next: AssistSettings = {
      enabled: input.enabled,
      allowRestricted: input.allowRestricted,
      consentedProvider: consented ? input.consentedProvider : null,
      consentedBy: consented
        ? ctx.principal.actor.kind === 'operator'
          ? ctx.principal.actor.operatorId
          : null
        : null,
      consentedAt: consented ? ctx.clock.now() : null,
    };
    await ctx.assist.saveSettings(next);
    return settingsView(next, ctx.assistProviderLabel);
  },
});

export const suggestAlt = defineUseCase({
  name: 'assist.alt.suggest',
  kind: 'command',
  description: 'Queue an image alt-text proposal for one block and locale.',
  requires: 'ai:assist',
  authenticatedOnly: true,
  consumes: 'ai.monthly_max',
  input: z
    .object({
      itemId: uuid,
      baseRevisionId: uuid,
      blockId: z.string().min(1),
      locale: z.string().min(2),
    })
    .strict(),
  output: z.object({ suggestionId: uuid, status: z.literal('pending') }),
  examples: [
    {
      input: {
        itemId: exampleId,
        baseRevisionId: exampleId,
        blockId: 'example-image',
        locale: 'nl',
      },
    },
  ],
  async handler(ctx, input) {
    if (!ctx.principal.entitlements['ai.assist']) refuse('limit_exceeded', 'ai-not-entitled');
    await ctx.assist.lockQuota();
    const now = ctx.clock.now();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    if ((await ctx.assist.countSince(month)) >= ctx.principal.entitlements['ai.monthly_max'])
      refuse('limit_exceeded', 'limit-reached');
    const item = await ctx.content.get(input.itemId);
    if (!item) throw new UseCaseError('not_found', 'item not found');
    assertBase(item, input.baseRevisionId);
    const revision = await ctx.content.revision(item.id, item.latestRevisionId);
    if (!revision) throw new UseCaseError('not_found', 'revision not found');
    const provider = ctx.assistProviderLabel;
    if (!provider) refuse('invalid_input', 'unavailable');
    const settings = await ctx.assist.settings();
    if (!settings.enabled) refuse('invalid_input', 'ai-disabled');
    if (settings.consentedProvider !== provider) refuse('invalid_input', 'consent-required');
    if (!revision.document.locales.includes(input.locale)) refuse('invalid_input', 'locale');
    if (revision.document.access.level !== 'public' && !settings.allowRestricted)
      refuse('invalid_input', 'restricted-content');
    const block = revision.document.blocks.find((candidate) => candidate.id === input.blockId);
    if (!block || block.type !== 'image')
      throw new UseCaseError('invalid_input', 'image block not found');
    if (block.props.decorative) refuse('invalid_input', 'image');
    const media = await ctx.media.get(block.props.mediaId);
    if (!media || media.deletedAt || media.kind !== 'image') refuse('invalid_input', 'image');
    if ((await ctx.assist.pendingCount(new Date(now.getTime() - 600_000))) >= 3)
      refuse('limit_exceeded', 'limit-reached');
    if (
      ctx.principal.actor.kind === 'operator' &&
      (await ctx.assist.countByOperatorSince(
        ctx.principal.actor.operatorId,
        new Date(now.getTime() - 3_600_000)
      )) >= 30
    )
      refuse('limit_exceeded', 'limit-reached');
    const id = ctx.ids.next();
    await ctx.assist.insert({
      id,
      itemId: item.id,
      baseRevisionId: input.baseRevisionId,
      blockId: input.blockId,
      locale: input.locale,
      status: 'pending',
      value: null,
      failure: null,
      provider: provider!,
      requestedBy: ctx.principal.actor.kind === 'operator' ? ctx.principal.actor.operatorId : null,
      model: null,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.jobs.enqueue({
      type: 'assist.run',
      key: jobKey('assist.run', id),
      runAt: now,
      payload: { suggestionId: id },
    });
    return { suggestionId: id, status: 'pending' as const };
  },
});

export const getSuggestion = defineUseCase({
  name: 'assist.suggestion.get',
  kind: 'query',
  description: 'Read one tenant-owned assistance proposal.',
  requires: 'content:read',
  authenticatedOnly: true,
  input: z.object({ suggestionId: uuid }),
  output: SuggestionView,
  examples: [{ input: { suggestionId: exampleId } }],
  async handler(ctx, { suggestionId }) {
    return suggestionView(await findSuggestion(ctx, suggestionId), ctx.clock.now());
  },
});

export const listSuggestions = defineUseCase({
  name: 'assist.suggestion.list',
  kind: 'query',
  description: 'List assistance proposals for one content item.',
  requires: 'content:read',
  authenticatedOnly: true,
  input: z.object({ itemId: uuid }),
  output: z.object({ suggestions: z.array(SuggestionView) }),
  examples: [{ input: { itemId: exampleId } }],
  async handler(ctx, { itemId }) {
    return {
      suggestions: (await ctx.assist.list(itemId)).map((s) => suggestionView(s, ctx.clock.now())),
    };
  },
});

export const dismissSuggestion = defineUseCase({
  name: 'assist.suggestion.dismiss',
  kind: 'command',
  description: 'Dismiss a proposal without changing content.',
  requires: 'content:write',
  authenticatedOnly: true,
  actors: ['operator'],
  input: z.object({ suggestionId: uuid }),
  output: SuggestionView,
  examples: [{ input: { suggestionId: exampleId } }],
  async handler(ctx, { suggestionId }) {
    const row = await findSuggestion(ctx, suggestionId);
    if (
      row.status !== 'ready' &&
      row.status !== 'failed' &&
      !(row.status === 'pending' && ctx.clock.now().getTime() - row.createdAt.getTime() > 600_000)
    )
      refuse('conflict', 'not-ready');
    if (!(await ctx.assist.decide(row.id, 'dismissed', ctx.clock.now())))
      refuse('conflict', 'not-ready');
    return suggestionView(
      { ...row, status: 'dismissed', value: null, updatedAt: ctx.clock.now() },
      ctx.clock.now()
    );
  },
});

export const acceptSuggestion = defineUseCase({
  name: 'assist.suggestion.accept',
  kind: 'command',
  description: 'Accept or edit an alt-text proposal as a new unpublished revision.',
  requires: 'content:write',
  authenticatedOnly: true,
  actors: ['operator'],
  input: z
    .object({ suggestionId: uuid, baseRevisionId: uuid, value: AltResult.shape.alt.optional() })
    .strict(),
  output: z.object({ revisionId: uuid }),
  examples: [{ input: { suggestionId: exampleId, baseRevisionId: exampleId } }],
  async handler(ctx, { suggestionId, baseRevisionId, value }) {
    const row = await findSuggestion(ctx, suggestionId);
    if (row.status !== 'ready' || !row.value || !row.model) refuse('conflict', 'not-ready');
    const item = await lockItem(ctx, row.itemId);
    assertBase(item, baseRevisionId);
    if (row.baseRevisionId !== item.latestRevisionId) refuse('conflict', 'stale');
    const revision = await ctx.content.revision(item.id, item.latestRevisionId);
    if (!revision) throw new UseCaseError('not_found', 'revision not found');
    const alt = AltResult.safeParse({ alt: value ?? row.value });
    if (!alt.success || !alt.data) {
      throw new UseCaseError('invalid_input', 'image', [
        { path: '', message: 'assist.error.image' },
      ]);
    }
    const acceptedAlt = alt.data.alt;
    const blocks = revision.document.blocks.map((block) =>
      block.id === row.blockId && block.type === 'image'
        ? {
            ...block,
            props: {
              ...block.props,
              alt: { ...(block.props.alt ?? {}), [row.locale]: acceptedAlt },
            },
          }
        : block
    );
    if (blocks.every((block, index) => block === revision.document.blocks[index]))
      refuse('conflict', 'stale');
    const doc = ContentDocument.parse({ ...revision.document, blocks });
    const written = await writeRevision(ctx, item, doc, {
      suggestionId: row.id,
      task: 'alt',
      provider: row.provider,
      model: row.model!,
      edited: value !== undefined && value !== row.value,
    });
    if (!(await ctx.assist.decide(row.id, 'accepted', ctx.clock.now())))
      refuse('conflict', 'not-ready');
    return { revisionId: written.revision.id };
  },
});
