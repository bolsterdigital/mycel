// The read, provider call and completion are three separate phases. The provider sees only a
// re-encoded variant and an optional caption. Rejected: passing the entire document or holding
// the tenant transaction open while waiting for a model.

import type { UnitOfWork } from '../ports.js';
import { systemPrincipal } from '../principal.js';
import { active, entitled } from '../entitlements/guards.js';
import type { TenantAccess } from '../entitlements/model.js';
import { mediaKey, variantFile } from '../media/model.js';
import { AltResult, PENDING_TIMEOUT_MS } from './model.js';
import {
  TranslationResult,
  decodeTranslation,
  translationValue,
  translatedValue,
} from './translation.js';
import { TextModelError, type ModelFailure, type TextModel } from './ports.js';

interface RunOptions {
  uow: UnitOfWork;
  model: TextModel | null;
  tenantId: string;
  suggestionId: string;
  attempts: number;
  timeoutMs: number;
  now: () => Date;
  access?: TenantAccess;
}

export async function runAssistSuggestion(options: RunOptions): Promise<{ next?: Date }> {
  const started = performance.now();
  const { uow, tenantId, suggestionId, now } = options;
  const principal = systemPrincipal(tenantId, 'jobs:assist.run', options.access);
  const source = await uow.run(principal, async (ctx) => {
    const row = await ctx.assist.get(suggestionId);
    if (!row || row.status !== 'pending') return null;
    if (now().getTime() - row.createdAt.getTime() > PENDING_TIMEOUT_MS)
      return { row, failure: 'timeout' as const };
    const settings = await ctx.assist.settings();
    if (
      !settings.enabled ||
      settings.consentedProvider !== row.provider ||
      ctx.assistProviderLabel !== row.provider ||
      !entitled(ctx.principal, 'ai.assist') ||
      !active(ctx.principal)
    )
      return { row, failure: 'rejected' as const };
    const item = await ctx.content.get(row.itemId);
    const revision = item && (await ctx.content.revision(item.id, item.latestRevisionId));
    if (
      !item ||
      !revision ||
      item.latestRevisionId !== row.baseRevisionId ||
      (revision.document.access.level !== 'public' && !settings.allowRestricted)
    )
      return { row, failure: 'rejected' as const };
    const translation = decodeTranslation(row.blockId);
    if (translation) {
      if (
        translation.to !== row.locale ||
        !revision.document.locales.includes(translation.from) ||
        !revision.document.locales.includes(translation.to)
      )
        return { row, failure: 'rejected' as const };
      const values: Record<string, string> = {};
      for (const target of translation.targets) {
        const text = translationValue(revision.document, target, translation.from);
        if (text === null) return { row, failure: 'rejected' as const };
        values[target] = text;
      }
      return { row, translation, values, document: revision.document };
    }
    const block = revision.document.blocks.find((candidate) => candidate.id === row.blockId);
    if (!block || block.type !== 'image' || block.props.decorative)
      return { row, failure: 'rejected' as const };
    const media = await ctx.media.get(block.props.mediaId);
    if (!media || media.deletedAt || media.kind !== 'image')
      return { row, failure: 'rejected' as const };
    const variant = media.variants
      .filter((v) => v.format === 'webp' && v.width && v.width <= 960)
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
    if (!variant) return { row, failure: 'unavailable' as const };
    const bytes = await ctx.blobs.get(mediaKey(tenantId, media.id, variantFile(variant)));
    if (!bytes) return { row, failure: 'unavailable' as const };
    return { row, bytes, caption: block.props.caption?.[row.locale] ?? null };
  });
  if (!source) return {};

  let failure: ModelFailure | null = 'failure' in source ? source.failure : null;
  let value: string | null = null;
  let modelName: string | null = null;
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  if (!failure && 'translation' in source && options.model) {
    try {
      const result = await options.model.complete({
        task: 'translate',
        system:
          'Translate only the provided Markdown or text values. Preserve links, footnote identifiers, headings and list structure. Return JSON values keyed by the same target names.',
        parts: [
          {
            kind: 'text',
            text: JSON.stringify({
              from: source.translation.from,
              to: source.translation.to,
              values: source.values,
            }),
          },
        ],
        output: TranslationResult,
        maxTokens: 3000,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const parsed = TranslationResult.safeParse(result.json);
      if (
        !parsed.success ||
        Object.keys(parsed.data.values).sort().join() !==
          source.translation.targets.slice().sort().join()
      )
        failure = 'invalid-output';
      else {
        for (const target of source.translation.targets) {
          const text = parsed.data.values[target];
          if (
            text === undefined ||
            translatedValue(
              source.document!,
              target,
              source.translation.from,
              source.translation.to,
              text
            ) === null
          ) {
            failure = 'invalid-output';
            break;
          }
        }
        if (!failure) {
          value = JSON.stringify(parsed.data);
          modelName = result.model;
          usage = result.usage;
        }
      }
    } catch (error) {
      failure =
        error instanceof TextModelError
          ? error.failure
          : error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
            ? 'timeout'
            : 'unavailable';
    }
  } else if (!failure && 'bytes' in source && options.model) {
    try {
      const result = await options.model.complete({
        task: 'alt',
        system: 'Describe only the visible image in plain alt text. Return JSON with an alt field.',
        parts: [
          {
            kind: 'text',
            text: `Locale: ${source.row.locale}${source.caption ? `\nCaption: ${source.caption}` : ''}`,
          },
          { kind: 'image', contentType: 'image/webp', bytes: source.bytes },
        ],
        output: AltResult,
        maxTokens: 200,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const parsed = AltResult.safeParse(result.json);
      if (!parsed.success) failure = 'invalid-output';
      else {
        value = parsed.data.alt;
        modelName = result.model;
        usage = result.usage;
      }
    } catch (error) {
      failure =
        error instanceof TextModelError
          ? error.failure
          : error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
            ? 'timeout'
            : 'unavailable';
    }
  } else if (!failure) failure = 'unavailable';

  if ((failure === 'timeout' || failure === 'unavailable') && options.attempts < 2)
    return { next: new Date(now().getTime() + 30_000) };

  await uow.run(principal, async (ctx) => {
    const changed = await ctx.assist.complete(suggestionId, {
      status: failure ? 'failed' : 'ready',
      value,
      failure,
      model: modelName,
      updatedAt: now(),
    });
    if (changed)
      ctx.log.info('assist.run.finished', {
        suggestionId,
        task: 'translation' in source ? 'translate' : 'alt',
        provider: source.row.provider,
        model: modelName,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        outcome: failure ?? 'ready',
        durationMs: Math.round(performance.now() - started),
      });
  });
  return {};
}

export async function retainAssistSuggestions(
  uow: UnitOfWork,
  tenantId: string,
  before: Date
): Promise<number> {
  return uow.run(systemPrincipal(tenantId, 'jobs:assist.retention'), (ctx) =>
    ctx.assist.deleteBefore(before)
  );
}
