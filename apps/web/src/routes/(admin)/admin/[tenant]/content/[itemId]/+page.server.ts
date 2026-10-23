// The edit page of one item (TODO #11, brief content-editor § A1): the document fields of the
// latest revision, saved as a new revision through `content.item.update` with the revision the
// form was opened on as `baseRevisionId` (ADR 018 rule 2). The blocks are not edited here yet
// (brief § B); `documentFrom` carries them over unchanged.
//
// A conflict shows both versions, as the ADR asks: the form keeps what was typed, a notice names
// who saved the newer revision and when, and a table lists what changed between the revision the
// form was opened on and the newest. The form then carries the newest id, so saving again is a
// deliberate choice to put these values on top. Rejected: last-write-wins with a warning, and a
// silent merge (which field wins is the editor's call, not ours).
import { error, fail, redirect } from '@sveltejs/kit';
import { UseCaseError, useCases, type ContentDocument, type Principal } from '@mycel/core';
import { failureOf } from '#lib/server/admin-actions.js';
import { requireTenantPrincipal } from '#lib/server/admin.js';
import {
  actorLabel,
  diffRows,
  documentFrom,
  valuesFromForm,
  valuesOf,
  when,
} from '#lib/server/content-admin.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The item with its latest revision, or a 404 for an unknown id or another site's. */
async function latest(principal: Principal, itemId: string) {
  if (!UUID.test(itemId)) error(404, 'Not found');
  try {
    return await runtime().invoker.run(useCases.getItem, principal, { itemId });
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') error(404, 'Not found');
    throw e;
  }
}

export const load: PageServerLoad = async ({ parent, locals, params, url }) => {
  const { tenant } = await parent();
  const principal = locals.principal!;
  const { item, revision } = await latest(principal, params.itemId);
  const doc = revision.document;
  const { invoker } = runtime();
  const [authors, sections] =
    doc.type === 'article'
      ? await Promise.all([
          invoker.run(useCases.listAuthors, principal, { limit: 100 }),
          invoker.run(useCases.listSections, principal, { limit: 100 }),
        ])
      : [{ authors: [] }, { sections: [] }];
  return {
    item: {
      id: item.id,
      type: item.type,
      slug: item.slug,
      defaultLocale: item.defaultLocale,
      publication: item.publication.map((p) => ({
        locale: p.locale,
        status: p.status,
        changes: p.hasUnpublishedChanges,
      })),
    },
    revision: { id: revision.id, when: when(revision.createdAt), who: actorLabel(revision.actor) },
    blockCount: doc.blocks.length,
    corrections: doc.type === 'article' ? doc.corrections : [],
    values: valuesOf(doc),
    // The site's locales first, then any the document has that the site no longer does.
    locales: [...new Set([...tenant.locales, ...doc.locales])],
    authors: authors.authors.map((a) => ({ id: a.id, name: a.name })),
    sections: sections.sections.map((s) => ({
      id: s.id,
      title: s.title[tenant.defaultLocale] ?? Object.values(s.title)[0] ?? s.slug,
    })),
    saved: url.searchParams.has('saved'),
  };
};

/** Core's issue keys on a save, as admin copy; anything else is the generic invalid message. */
const ISSUES: Record<string, UiKey> = {
  'i18n.default-not-in-locales': 'admin.content.error.defaultLocale',
  'content.seo.canonical.invalid': 'admin.content.error.canonical',
  'content.tag.invalid': 'admin.content.error.tag',
  'content.access.marker-needs-one-paywall': 'admin.content.error.marker',
  'content.access.teaser-too-long': 'admin.content.error.teaserTooLong',
  'content.access.tier-ids-required': 'admin.content.error.tier',
};

export const actions: Actions = {
  save: async ({ locals, url, params, request }) => {
    const { tenant, principal } = await requireTenantPrincipal(locals, url, params.tenant);
    const values = valuesFromForm(await request.formData());
    const baseRevisionId = typeof values.baseRevisionId === 'string' ? values.baseRevisionId : '';
    const rt = runtime();
    let base: ContentDocument;
    try {
      const got = await rt.invoker.run(useCases.getItem, principal, {
        itemId: params.itemId,
        revisionId: baseRevisionId,
      });
      base = got.revision.document;
      await rt.invoker.run(useCases.updateItem, principal, {
        itemId: params.itemId,
        baseRevisionId,
        document: documentFrom(base, values, rt.clock.now().toISOString().slice(0, 10)),
      });
    } catch (e) {
      if (!(e instanceof UseCaseError)) throw e;
      const { status, body } = failureOf(e, 'save', {
        conflict: 'admin.content.conflict.title',
        invalid: 'admin.content.error.invalid',
        issues: ISSUES,
      });
      if (e.code !== 'conflict') return fail(status, { ...body, values, conflict: null });
      const { item, revision } = await latest(principal, params.itemId);
      const { changes } = await rt.invoker.run(useCases.diffRevisions, principal, {
        itemId: item.id,
        fromRevisionId: baseRevisionId,
        toRevisionId: revision.id,
      });
      return fail(status, {
        ...body,
        values: { ...values, baseRevisionId: revision.id },
        conflict: {
          who: actorLabel(revision.actor),
          when: when(revision.createdAt),
          changes: diffRows(changes),
        },
      });
    }
    redirect(303, `/admin/${tenant.slug}/content/${params.itemId}?saved`);
  },
};
