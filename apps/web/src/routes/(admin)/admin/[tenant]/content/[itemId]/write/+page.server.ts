// Article writing is an enhancement of the existing block editor (ADR 020.5). A JSON autosave
// still calls content.item.update with baseRevisionId, so a second operator gets the same typed
// conflict as the native forms. Rejected: a separate draft endpoint or last-write-wins state.
import { fail, error } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { UseCaseError, can, useCases } from '@mycel/core';
import {
  EditorInputError,
  fromArticleEditor,
  toArticleEditor,
} from '#lib/editor/article-document.js';
import { actorLabel, diffRows, when } from '#lib/server/content-admin.js';
import { adminTimeZone, requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { mediaChoices } from '#lib/server/content-blocks.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const { tenant, principal } = await requireTenantPrincipal(locals, url, params.tenant);
  const { item, revision } = await runtime().invoker.run(useCases.getItem, principal, {
    itemId: params.itemId,
  });
  if (item.type !== 'article') error(404, 'Not found');
  const locale = url.searchParams.get('locale') ?? tenant.defaultLocale;
  if (!revision.document.locales.includes(locale)) error(404, 'Locale not found');
  return {
    tenant: { slug: tenant.slug, name: tenant.name },
    contentType: item.type,
    itemId: item.id,
    locale,
    locales: revision.document.locales,
    revisionId: revision.id,
    editor: toArticleEditor(revision.document, locale),
    cards: revision.document.blocks
      .filter((block) => block.type !== 'rich-text')
      .map((block) => ({ id: block.id, type: block.type })),
    // A pasted image becomes a card that waits for an image from the library (brief media-picker).
    media: await mediaChoices(principal, []),
    upload: can(principal, 'media:write'),
    missingTranslations: revision.document.locales.filter((l) => !revision.document.title[l]),
    missingAlt: revision.document.blocks
      .filter(
        (block) => block.type === 'image' && !block.props.decorative && !block.props.alt?.[locale]
      )
      .map((block) => block.id),
  };
};

export const actions: Actions = {
  save: async ({ locals, params, request, url }) => {
    const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
    const form = await request.formData();
    const baseRevisionId = String(form.get('baseRevisionId') ?? '');
    const locale = String(form.get('locale') ?? '');
    const raw = String(form.get('editor') ?? '');
    if (raw.length > 2_000_000) return fail(413, { kind: 'invalid' });
    const rt = runtime();
    try {
      const { item, revision } = await rt.invoker.run(useCases.getItem, principal, {
        itemId: params.itemId,
        revisionId: baseRevisionId,
      });
      if (item.type !== 'article') error(404, 'Not found');
      const document = fromArticleEditor(revision.document, locale, JSON.parse(raw));
      const saved = await rt.invoker.run(useCases.updateItem, principal, {
        itemId: item.id,
        baseRevisionId,
        document,
      });
      return { kind: 'saved', revisionId: saved.revision.id };
    } catch (cause) {
      if (cause instanceof UseCaseError) {
        if (cause.code === 'conflict') {
          const { revision } = await rt.invoker.run(useCases.getItem, principal, {
            itemId: params.itemId,
          });
          const { changes } = await rt.invoker.run(useCases.diffRevisions, principal, {
            itemId: params.itemId,
            fromRevisionId: baseRevisionId,
            toRevisionId: revision.id,
          });
          return fail(409, {
            kind: 'conflict',
            revisionId: revision.id,
            editor: toArticleEditor(revision.document, locale),
            who: actorLabel(revision.actor),
            when: when(revision.createdAt, (await adminTimeZone(locals)).zone),
            changes: diffRows(changes),
          });
        }
        return fail(cause.code === 'forbidden' ? 403 : 400, { kind: cause.code });
      }
      if (cause instanceof ZodError)
        return fail(400, {
          kind: 'invalid',
          issues: cause.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        });
      if (cause instanceof SyntaxError || cause instanceof EditorInputError)
        return fail(400, { kind: 'invalid' });
      throw cause;
    }
  },
};
