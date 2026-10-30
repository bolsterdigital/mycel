// A suggestion is a proposal, never a content write. The request transaction checks consent,
// quota and the revision, then queues a worker; only an operator's later acceptance writes a
// revision. Rejected: calling a provider from a use case, which holds an RLS transaction open.

import { z } from 'zod';
import { ContentDocument } from '../content/model.js';
import {
  TranslationResult,
  TranslationTargets,
  expandTranslationTargets,
  encodeTranslation,
  decodeTranslation,
  translationValue,
  translatedValue,
  applyTranslation,
} from './translation.js';
import { assertBase, lockItem, writeRevision } from '../content/service.js';
import type { LimitName } from '../entitlements/model.js';
import { requireEntitled, withinLimit } from '../entitlements/guards.js';
import { notFound, UseCaseError } from '../errors.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { jobKey } from '../jobs/types.js';
import { AltResult, PENDING_TIMEOUT_MS, SettingsView, SuggestionView } from './model.js';
import type { AssistSettings, AssistSuggestion } from './ports.js';
import './ports.js';

const uuid = z.string().guid();
const exampleId = '01900000-0000-7000-8000-000000000001';
const OPERATOR_WINDOW_MS = 3_600_000;
const iso = (date: Date | null) => date?.toISOString() ?? null;
const settingsView = (settings: AssistSettings, provider: string | null) => ({
  ...settings,
  consentedAt: iso(settings.consentedAt),
  provider,
});
const timedOut = (s: AssistSuggestion, now: Date) =>
  s.status === 'pending' && now.getTime() - s.createdAt.getTime() > PENDING_TIMEOUT_MS;
const suggestionView = (s: AssistSuggestion, now: Date) => ({
  ...s,
  status: timedOut(s, now) ? ('failed' as const) : s.status,
  failure: timedOut(s, now) ? ('timeout' as const) : s.failure,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});
const refuse = (code: 'invalid_input' | 'limit_exceeded' | 'conflict', issue: string): never => {
  throw new UseCaseError(code, issue, [{ path: '', message: `assist.error.${issue}` }]);
};
/**
 * The one gate every `ai:assist` command passes first (ADR 015, TODO #53): the entitlement, the
 * monthly quota and both throttles under the quota lock, then the item at its base revision, the
 * processor and the site's consent. The throttles are entitlements (`ai.pending_max`,
 * `ai.operator_hourly_max`), so a hoster sees and sets them like any other limit. The registry
 * conformance runs every `ai:assist` command with the entitlement off and with no pending room,
 * so a command that skips this gate fails `verify`. Rejected: the checks inline per command,
 * which drifted (the alt command throttled only after loading the item).
 */
async function assistGate(
  ctx: TransactionContext,
  target: { itemId: string; baseRevisionId: string }
) {
  requireEntitled(ctx.principal, 'ai.assist', 'assist.error.ai-not-entitled');
  await ctx.assist.lockQuota();
  const now = ctx.clock.now();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const limit = (name: LimitName, count: number) =>
    withinLimit(ctx, name, count, 1, 'assist.error.limit-reached');
  limit('ai.monthly_max', await ctx.assist.countSince(month));
  limit(
    'ai.pending_max',
    await ctx.assist.pendingCount(new Date(now.getTime() - PENDING_TIMEOUT_MS))
  );
  const { actor } = ctx.principal;
  if (actor.kind === 'operator')
    limit(
      'ai.operator_hourly_max',
      await ctx.assist.countByOperatorSince(
        actor.operatorId,
        new Date(now.getTime() - OPERATOR_WINDOW_MS)
      )
    );
  const item = await ctx.content.get(target.itemId);
  if (!item) throw notFound('content item');
  assertBase(item, target.baseRevisionId);
  const revision = await ctx.content.revision(item.id, item.latestRevisionId);
  if (!revision) throw notFound('revision');
  const provider = ctx.assistProviderLabel;
  if (!provider) return refuse('invalid_input', 'unavailable');
  const settings = await ctx.assist.settings();
  if (!settings.enabled) refuse('invalid_input', 'ai-disabled');
  if (settings.consentedProvider !== provider) refuse('invalid_input', 'consent-required');
  return { now, item, revision, provider, settings };
}

const findSuggestion = async (ctx: TransactionContext, id: string): Promise<AssistSuggestion> => {
  const row = await ctx.assist.get(id);
  if (!row) throw notFound('suggestion');
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
    const { now, item, revision, provider, settings } = await assistGate(ctx, input);
    if (!revision.document.locales.includes(input.locale)) refuse('invalid_input', 'locale');
    if (revision.document.access.level !== 'public' && !settings.allowRestricted)
      refuse('invalid_input', 'restricted-content');
    const block = revision.document.blocks.find((candidate) => candidate.id === input.blockId);
    if (!block || block.type !== 'image')
      throw new UseCaseError('invalid_input', 'image block not found');
    if (block.props.decorative) refuse('invalid_input', 'image');
    const media = await ctx.media.get(block.props.mediaId);
    if (!media || media.deletedAt || media.kind !== 'image') refuse('invalid_input', 'image');
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
      provider,
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
    if (row.status !== 'ready' && row.status !== 'failed' && !timedOut(row, ctx.clock.now()))
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
  description: 'Accept or edit an assistance proposal as a new unpublished revision.',
  requires: 'content:write',
  authenticatedOnly: true,
  actors: ['operator'],
  input: z
    .object({ suggestionId: uuid, baseRevisionId: uuid, value: z.string().optional() })
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
    if (!revision) throw notFound('revision');
    const translation = decodeTranslation(row.blockId);
    if (translation) {
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(value ?? row.value!);
      } catch {
        refuse('invalid_input', 'invalid-output');
      }
      const edited = TranslationResult.safeParse(parsedValue);
      if (
        !edited.success ||
        Object.keys(edited.data.values).sort().join() !== translation.targets.slice().sort().join()
      )
        throw new UseCaseError('invalid_input', 'invalid-output');
      let doc: ContentDocument = revision.document;
      for (const target of translation.targets) {
        const source = translationValue(doc, target, translation.from);
        if (source === null) refuse('conflict', 'stale');
        const text = edited.data.values[target];
        if (text === undefined) throw new UseCaseError('invalid_input', 'invalid-output');
        const validated = translatedValue(doc, target, translation.from, translation.to, text);
        if (validated === null) refuse('invalid_input', 'invalid-output');
        const next = applyTranslation(doc, target, translation.to, validated);
        if (!next) throw new UseCaseError('invalid_input', 'invalid-output');
        doc = next;
      }
      const markers = { ...(doc.machineTranslation ?? {}) };
      markers[translation.to] = [
        ...new Set([...(markers[translation.to] ?? []), ...translation.targets]),
      ];
      doc = ContentDocument.parse({ ...doc, machineTranslation: markers });
      const written = await writeRevision(ctx, item, doc, {
        suggestionId: row.id,
        task: 'translate',
        provider: row.provider,
        model: row.model!,
        edited: value !== undefined && value !== row.value,
      });
      if (!(await ctx.assist.decide(row.id, 'accepted', ctx.clock.now())))
        refuse('conflict', 'not-ready');
      return { revisionId: written.revision.id };
    }
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

export const suggestTranslation = defineUseCase({
  name: 'assist.translation.suggest',
  kind: 'command',
  description: 'Queue a proposal for selected fields in one source and target locale.',
  requires: 'ai:assist',
  authenticatedOnly: true,
  consumes: 'ai.monthly_max',
  input: z
    .object({
      itemId: uuid,
      baseRevisionId: uuid,
      from: z.string().min(2),
      to: z.string().min(2),
      targets: TranslationTargets,
    })
    .strict(),
  output: z.object({ suggestionId: uuid, status: z.literal('pending') }),
  examples: [
    {
      input: {
        itemId: exampleId,
        baseRevisionId: exampleId,
        from: 'nl',
        to: 'en',
        targets: ['title'],
      },
    },
  ],
  async handler(ctx, input) {
    const { now, item, revision, provider, settings } = await assistGate(ctx, input);
    const doc = revision.document;
    if (
      input.from === input.to ||
      !doc.locales.includes(input.from) ||
      !doc.locales.includes(input.to)
    )
      refuse('invalid_input', 'locale');
    if (doc.access.level !== 'public' && !settings.allowRestricted)
      refuse('invalid_input', 'restricted-content');
    const targets = expandTranslationTargets(doc, input.targets);
    if (targets.length === 0 || targets.length > 20 || new Set(targets).size !== targets.length)
      refuse('invalid_input', 'target');
    for (const target of targets)
      if (translationValue(doc, target, input.from) === null) refuse('invalid_input', 'target');
    const id = ctx.ids.next();
    await ctx.assist.insert({
      id,
      itemId: item.id,
      baseRevisionId: input.baseRevisionId,
      blockId: encodeTranslation({ from: input.from, to: input.to, targets }),
      locale: input.to,
      status: 'pending',
      value: null,
      failure: null,
      provider,
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
