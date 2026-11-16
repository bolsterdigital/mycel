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
import { LeadBlockIds, leadSource } from './lead.js';
import { headlineSource } from './headline.js';
import { readSectionCandidates, sectionLead, sectionToken } from './section.js';
import type { AssistSettings, AssistSuggestion, AssistTask } from './ports.js';
import './ports.js';
import { iso } from '../util/date.js';
import { Uuid, exampleId } from '../util/ids.js';

const OPERATOR_WINDOW_MS = 3_600_000;
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

/** Stores a pending proposal and queues its worker; the row's own fields name task and source. */
async function queueSuggestion(
  ctx: TransactionContext,
  now: Date,
  row: Pick<
    AssistSuggestion,
    'itemId' | 'baseRevisionId' | 'task' | 'blockId' | 'sourceBlockIds' | 'locale' | 'provider'
  >
) {
  const id = ctx.ids.next();
  await ctx.assist.insert({
    ...row,
    id,
    status: 'pending',
    value: null,
    failure: null,
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
}

export const getAssistSettings = defineUseCase({
  name: 'assist.settings.get',
  kind: 'query',
  description: 'Read this site’s assistance consent and configured processor.',
  requires: 'content:read',
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
  consumes: 'ai.monthly_max',
  input: z
    .object({
      itemId: Uuid,
      baseRevisionId: Uuid,
      blockId: z.string().min(1),
      locale: z.string().min(2),
    })
    .strict(),
  output: z.object({ suggestionId: Uuid, status: z.literal('pending') }),
  examples: [
    {
      input: {
        itemId: exampleId(1),
        baseRevisionId: exampleId(1),
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
    return queueSuggestion(ctx, now, {
      itemId: item.id,
      baseRevisionId: input.baseRevisionId,
      task: 'alt',
      blockId: input.blockId,
      sourceBlockIds: [],
      locale: input.locale,
      provider,
    });
  },
});

export const getSuggestion = defineUseCase({
  name: 'assist.suggestion.get',
  kind: 'query',
  description: 'Read one tenant-owned assistance proposal.',
  requires: 'content:read',
  input: z.object({ suggestionId: Uuid }),
  output: SuggestionView,
  examples: [{ input: { suggestionId: exampleId(1) } }],
  async handler(ctx, { suggestionId }) {
    return suggestionView(await findSuggestion(ctx, suggestionId), ctx.clock.now());
  },
});

export const listSuggestions = defineUseCase({
  name: 'assist.suggestion.list',
  kind: 'query',
  description: 'List assistance proposals for one content item.',
  requires: 'content:read',
  input: z.object({ itemId: Uuid }),
  output: z.object({ suggestions: z.array(SuggestionView) }),
  examples: [{ input: { itemId: exampleId(1) } }],
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
  actors: ['operator'],
  input: z.object({ suggestionId: Uuid }),
  output: SuggestionView,
  examples: [{ input: { suggestionId: exampleId(1) } }],
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
  actors: ['operator'],
  input: z
    .object({ suggestionId: Uuid, baseRevisionId: Uuid, value: z.string().optional() })
    .strict(),
  output: z.object({ revisionId: Uuid }),
  examples: [{ input: { suggestionId: exampleId(1), baseRevisionId: exampleId(1) } }],
  async handler(ctx, { suggestionId, baseRevisionId, value }) {
    const row = await findSuggestion(ctx, suggestionId);
    if (row.status !== 'ready' || !row.value || !row.model) refuse('conflict', 'not-ready');
    const item = await lockItem(ctx, row.itemId);
    assertBase(item, baseRevisionId);
    if (row.baseRevisionId !== item.latestRevisionId) refuse('conflict', 'stale');
    const revision = await ctx.content.revision(item.id, item.latestRevisionId);
    if (!revision) throw notFound('revision');
    const provenance = (task: AssistTask) => ({
      suggestionId: row.id,
      task,
      provider: row.provider,
      model: row.model!,
      edited: value !== undefined && value !== row.value,
    });
    if (row.task === 'section') {
      // The chosen id as proposed, never an edited one: another choice is the editor's own
      // select. The lead and the offered sections must still be what the request saw.
      if (value !== undefined && value !== row.value) refuse('invalid_input', 'section-value');
      const offered = await readSectionCandidates(ctx, row.locale);
      const doc = revision.document;
      if (
        doc.type !== 'article' ||
        !sectionLead(doc, row.locale).ok ||
        !offered.ok ||
        (await sectionToken(offered.candidates)) !== row.blockId ||
        !offered.candidates.some((c) => c.id === row.value)
      )
        return refuse('conflict', 'stale');
      // Already in that section: nothing to write, the proposal is still taken.
      const revisionId =
        doc.sectionId === row.value
          ? revision.id
          : (
              await writeRevision(
                ctx,
                item,
                ContentDocument.parse({ ...doc, sectionId: row.value }),
                provenance('section')
              )
            ).revision.id;
      if (!(await ctx.assist.decide(row.id, 'accepted', ctx.clock.now())))
        refuse('conflict', 'not-ready');
      return { revisionId };
    }
    if (row.task === 'headline') {
      // Only `title[locale]` changes; the edited text passes the article's own title schema.
      if (item.type !== 'article' || !headlineSource(revision.document, row.locale).ok)
        refuse('conflict', 'stale');
      const next = ContentDocument.safeParse({
        ...revision.document,
        title: { ...revision.document.title, [row.locale]: (value ?? row.value!).trim() },
      });
      if (!next.success) refuse('invalid_input', 'headline-value');
      const written = await writeRevision(ctx, item, next.data!, provenance('headline'));
      if (!(await ctx.assist.decide(row.id, 'accepted', ctx.clock.now())))
        refuse('conflict', 'not-ready');
      return { revisionId: written.revision.id };
    }
    if (row.task === 'lead') {
      // Only `lead[locale]` changes; the edited text passes the article's own lead schema.
      if (item.type !== 'article' || !revision.document.locales.includes(row.locale))
        refuse('conflict', 'stale');
      const lead = (value ?? row.value!).trim();
      const next = ContentDocument.safeParse({
        ...revision.document,
        lead: { ...(revision.document.lead ?? {}), [row.locale]: lead },
      });
      if (!next.success) refuse('invalid_input', 'lead-value');
      const written = await writeRevision(ctx, item, next.data!, provenance('lead'));
      if (!(await ctx.assist.decide(row.id, 'accepted', ctx.clock.now())))
        refuse('conflict', 'not-ready');
      return { revisionId: written.revision.id };
    }
    const translation = row.task === 'translate' ? decodeTranslation(row.blockId) : null;
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
      const written = await writeRevision(ctx, item, doc, provenance('translate'));
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
    const written = await writeRevision(ctx, item, doc, provenance('alt'));
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
  consumes: 'ai.monthly_max',
  input: z
    .object({
      itemId: Uuid,
      baseRevisionId: Uuid,
      from: z.string().min(2),
      to: z.string().min(2),
      targets: TranslationTargets,
    })
    .strict(),
  output: z.object({ suggestionId: Uuid, status: z.literal('pending') }),
  examples: [
    {
      input: {
        itemId: exampleId(1),
        baseRevisionId: exampleId(1),
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
    return queueSuggestion(ctx, now, {
      itemId: item.id,
      baseRevisionId: input.baseRevisionId,
      task: 'translate',
      blockId: encodeTranslation({ from: input.from, to: input.to, targets }),
      sourceBlockIds: [],
      locale: input.to,
      provider,
    });
  },
});

export const suggestLead = defineUseCase({
  name: 'assist.lead.suggest',
  kind: 'command',
  description:
    'Queue a lead proposal for an article from one to three of its text blocks in one locale.',
  requires: 'ai:assist',
  consumes: 'ai.monthly_max',
  input: z
    .object({
      itemId: Uuid,
      baseRevisionId: Uuid,
      locale: z.string().min(2),
      blockIds: LeadBlockIds,
    })
    .strict(),
  output: z.object({ suggestionId: Uuid, status: z.literal('pending') }),
  examples: [
    {
      input: {
        itemId: exampleId(1),
        baseRevisionId: exampleId(1),
        locale: 'nl',
        blockIds: ['example-text'],
      },
    },
  ],
  async handler(ctx, input) {
    const { now, item, revision, provider, settings } = await assistGate(ctx, input);
    const doc = revision.document;
    if (item.type !== 'article') refuse('invalid_input', 'article');
    if (!doc.locales.includes(input.locale)) refuse('invalid_input', 'locale');
    if (doc.access.level !== 'public' && !settings.allowRestricted)
      refuse('invalid_input', 'restricted-content');
    const source = leadSource(doc, input.blockIds, input.locale);
    if (!source.ok) return refuse('invalid_input', source.issue);
    return queueSuggestion(ctx, now, {
      itemId: item.id,
      baseRevisionId: input.baseRevisionId,
      task: 'lead',
      blockId: 'lead',
      sourceBlockIds: input.blockIds,
      locale: input.locale,
      provider,
    });
  },
});

export const suggestHeadline = defineUseCase({
  name: 'assist.headline.suggest',
  kind: 'command',
  description: 'Queue a headline proposal for an article from its own lead in one locale.',
  requires: 'ai:assist',
  consumes: 'ai.monthly_max',
  input: z.object({ itemId: Uuid, baseRevisionId: Uuid, locale: z.string().min(2) }).strict(),
  output: z.object({ suggestionId: Uuid, status: z.literal('pending') }),
  examples: [{ input: { itemId: exampleId(1), baseRevisionId: exampleId(1), locale: 'nl' } }],
  async handler(ctx, input) {
    const { now, item, revision, provider, settings } = await assistGate(ctx, input);
    const doc = revision.document;
    if (item.type !== 'article') refuse('invalid_input', 'article');
    if (!doc.locales.includes(input.locale)) refuse('invalid_input', 'locale');
    if (doc.access.level !== 'public' && !settings.allowRestricted)
      refuse('invalid_input', 'restricted-content');
    const source = headlineSource(doc, input.locale);
    if (!source.ok) return refuse('invalid_input', source.issue);
    return queueSuggestion(ctx, now, {
      itemId: item.id,
      baseRevisionId: input.baseRevisionId,
      task: 'headline',
      blockId: 'headline',
      sourceBlockIds: [],
      locale: input.locale,
      provider,
    });
  },
});

export const suggestSection = defineUseCase({
  name: 'assist.section.suggest',
  kind: 'command',
  description:
    'Queue a section proposal for an article from its own lead and the site’s sections in one locale.',
  requires: 'ai:assist',
  consumes: 'ai.monthly_max',
  input: z.object({ itemId: Uuid, baseRevisionId: Uuid, locale: z.string().min(2) }).strict(),
  output: z.object({ suggestionId: Uuid, status: z.literal('pending') }),
  examples: [{ input: { itemId: exampleId(1), baseRevisionId: exampleId(1), locale: 'nl' } }],
  async handler(ctx, input) {
    const { now, item, revision, provider, settings } = await assistGate(ctx, input);
    const doc = revision.document;
    if (item.type !== 'article') refuse('invalid_input', 'article');
    if (!doc.locales.includes(input.locale)) refuse('invalid_input', 'locale');
    if (doc.access.level !== 'public' && !settings.allowRestricted)
      refuse('invalid_input', 'restricted-content');
    const lead = sectionLead(doc, input.locale);
    if (!lead.ok) return refuse('invalid_input', lead.issue);
    const offered = await readSectionCandidates(ctx, input.locale);
    if (!offered.ok) return refuse('invalid_input', offered.issue);
    return queueSuggestion(ctx, now, {
      itemId: item.id,
      baseRevisionId: input.baseRevisionId,
      task: 'section',
      blockId: await sectionToken(offered.candidates),
      sourceBlockIds: [],
      locale: input.locale,
      provider,
    });
  },
});
