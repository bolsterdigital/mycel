// The edit page of one item (TODO #11, brief content-editor § A1): the document fields of the
// latest revision, saved as a new revision through `content.item.update` with the revision the
// form was opened on as `baseRevisionId` (ADR 018 rule 2); `documentFrom` carries the blocks over
// unchanged. Each block has its own forms (brief § B): its fields through `set_props` and a move
// up or down through `move`, both on the revision the page showed; inserting and removing have
// pages of their own (`blocks/new`, `blocks/[blockId]/remove`). Authors and section always list what
// the document or a failed post has, also beyond the first page of the directory (`withAssigned`).
//
// A conflict shows both versions, as the ADR asks: the form keeps what was typed, a notice names
// who saved the newer revision and when, and a table lists what changed between the revision the
// form was opened on and the newest. The form then carries the newest id, so saving again is a
// deliberate choice to put these values on top. Rejected: last-write-wins with a warning, and a
// silent merge (which field wins is the editor's call, not ours).
//
// The publication panel (brief § A2) acts per locale on the revision this page shows: publish,
// take offline, schedule (a time in the site zone, `content-admin-publication.ts`) and cancel a
// schedule; pinning the newest revision is a schedule of it at the pinned time. Buttons show only
// for `content:publish`; the registry refuses the rest regardless.
import { isDeepStrictEqual } from 'node:util';
import { error, fail, redirect } from '@sveltejs/kit';
import {
  BLOCK_DEFINITIONS,
  BLOCK_TYPES,
  UseCaseError,
  can,
  documentMedia,
  readinessIssues,
  useCases,
  type ContentDocument,
  type Principal,
  type Section,
  type TenantInfo,
} from '@mycel/core';
import { formValues, posted, propsFromForm } from '#lib/editor/block-form.js';
import { failureOf, text } from '#lib/server/admin-actions.js';
import { requireTenantPrincipal } from '#lib/server/admin.js';
import {
  actorLabel,
  diffRows,
  documentFrom,
  valuesFromForm,
  type FormValues,
  withAssigned,
  valuesOf,
  when,
} from '#lib/server/content-admin.js';
import {
  SITE_TIME_ZONE,
  fieldOf,
  fromLocalInput,
  issueKey,
  issuePath,
  localInput,
  localLabel,
} from '#lib/server/content-admin-publication.js';
import {
  type FieldIssue,
  fieldIssues,
  issueCopy as blockIssueCopy,
  pickerOptions,
  summaryOf,
} from '#lib/server/content-blocks.js';
import { runtime } from '#lib/server/runtime.js';
import { ui, type UiKey } from '../../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A lookup's result, or `null` when it is not there (any other error stays an error). */
async function orNull<T>(run: Promise<T>): Promise<T | null> {
  try {
    return await run;
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') return null;
    throw e;
  }
}

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

/** Resolve picker choices under the operator's tenant, including a failed post's selections. */
async function relationshipChoices(
  principal: Principal,
  defaultLocale: string,
  article: boolean,
  authorIds: string[],
  sectionId: string
) {
  const { invoker } = runtime();
  const author = (a: { id: string; name: string }) => ({ id: a.id, name: a.name });
  const section = (s: Section) => ({
    id: s.id,
    title: s.title[defaultLocale] ?? Object.values(s.title)[0] ?? s.slug,
  });
  const [authors, sections] = article
    ? await Promise.all([
        invoker.run(useCases.listAuthors, principal, { limit: 100 }).then(({ authors }) =>
          withAssigned(
            authorIds,
            authors.map(author),
            async (authorId) => {
              const a = UUID.test(authorId)
                ? await orNull(invoker.run(useCases.getAuthor, principal, { authorId }))
                : null;
              return a && author(a);
            },
            (id) => ({ id, name: id })
          )
        ),
        invoker.run(useCases.listSections, principal, { limit: 100 }).then(({ sections }) =>
          withAssigned(
            sectionId ? [sectionId] : [],
            sections.map(section),
            async (sectionId) => {
              const s = UUID.test(sectionId)
                ? await orNull(invoker.run(useCases.getSection, principal, { sectionId }))
                : null;
              return s && section(s);
            },
            (id) => ({ id, title: id })
          )
        ),
      ])
    : [[], []];
  return { authors, sections };
}

export const load: PageServerLoad = async ({ parent, locals, params, url }) => {
  const { tenant } = await parent();
  const principal = locals.principal!;
  const { item, revision } = await latest(principal, params.itemId);
  const doc = revision.document;
  const { invoker } = runtime();
  // Which revision is live or pinned, in the words of the revisions page; one lookup per id.
  const seen = new Map<string, Promise<{ when: string; who: string; latest: boolean }>>();
  const describe = (id: string) => {
    if (!seen.has(id))
      seen.set(
        id,
        (id === revision.id
          ? Promise.resolve(revision)
          : invoker
              .run(useCases.getItem, principal, { itemId: item.id, revisionId: id })
              .then((r) => r.revision)
        ).then((r) => ({
          when: when(r.createdAt),
          who: actorLabel(r.actor),
          latest: r.id === revision.id,
        }))
      );
    return seen.get(id)!;
  };
  const { authors, sections } = await relationshipChoices(
    principal,
    tenant.defaultLocale,
    doc.type === 'article',
    doc.type === 'article' ? doc.authorIds : [],
    doc.type === 'article' ? (doc.sectionId ?? '') : ''
  );
  const options = await pickerOptions(
    principal,
    doc.blocks,
    item.defaultLocale,
    documentMedia(doc).map((m) => m.mediaId)
  );
  const assistSettings =
    can(principal, 'ai:assist') && can(principal, 'content:write')
      ? await invoker.run(useCases.getAssistSettings, principal, {})
      : null;
  const assistEnabled = !!(
    assistSettings?.enabled &&
    assistSettings.provider &&
    assistSettings.consentedProvider === assistSettings.provider &&
    principal.entitlements['ai.assist'] &&
    (doc.access.level === 'public' || assistSettings.allowRestricted)
  );
  return {
    contentType: item.type,
    assistEnabled,
    machineTranslation: doc.machineTranslation ?? {},
    blocks: doc.blocks.map((b) => ({
      id: b.id,
      type: b.type,
      summary: summaryOf(b, item.defaultLocale),
      values: formValues(
        BLOCK_DEFINITIONS[b.type].fields,
        b.props as Record<string, unknown>,
        doc.locales
      ),
    })),
    openBlock: url.searchParams.get('block'),
    blockTypes: BLOCK_TYPES,
    docLocales: doc.locales,
    ...options,
    item: {
      id: item.id,
      type: item.type,
      slug: item.slug,
      defaultLocale: item.defaultLocale,
      publication: await Promise.all(
        item.publication.map(async (p) => ({
          locale: p.locale,
          status: p.status,
          changes: p.hasUnpublishedChanges,
          live: p.publishedRevisionId ? await describe(p.publishedRevisionId) : null,
          pin:
            p.scheduledRevisionId && p.scheduledFor
              ? {
                  at: localLabel(new Date(p.scheduledFor)),
                  input: localInput(new Date(p.scheduledFor)),
                  revision: await describe(p.scheduledRevisionId),
                }
              : null,
          issues: readinessIssues(doc, p.locale).map((i) => ({
            path: issuePath(i.path, i.message, p.locale),
            field: i.path.startsWith('blocks.')
              ? doc.blocks[Number(i.path.split('.')[1])]?.id
                ? `block-${doc.blocks[Number(i.path.split('.')[1])]!.id}`
                : null
              : fieldOf(i.path, p.locale),
            copy: issueCopy(i.message),
          })),
        }))
      ),
    },
    canPublish: can(principal, 'content:publish'),
    canWrite: can(principal, 'content:write'),
    restricted: doc.access.level !== 'public',
    timeZone: SITE_TIME_ZONE,
    done: DONE[url.searchParams.get('done') ?? ''] ?? null,
    doneLocale: url.searchParams.get('locale') ?? '',
    revision: { id: revision.id, when: when(revision.createdAt), who: actorLabel(revision.actor) },
    corrections: doc.type === 'article' ? doc.corrections : [],
    values: valuesOf(doc),
    // The site's locales first, then any the document has that the site no longer does.
    locales: [...new Set([...tenant.locales, ...doc.locales])],
    authors,
    sections,
    saved: url.searchParams.has('saved'),
  };
};

/** The notice after a publication action, by the `done` parameter of its redirect. */
const DONE: Record<string, UiKey> = {
  blockSaved: 'admin.block.done.saved',
  blockMoved: 'admin.block.done.moved',
  blockInserted: 'admin.block.done.inserted',
  blockRemoved: 'admin.block.done.removed',
  publish: 'admin.content.publication.done.publish',
  unpublish: 'admin.content.publication.done.unpublish',
  schedule: 'admin.content.publication.done.schedule',
  repin: 'admin.content.publication.done.schedule',
  unschedule: 'admin.content.publication.done.unschedule',
  translationApproved: 'admin.assist.approved',
};

/** Core's readiness and reference issues as admin copy; unknown keys get the generic line. */
const ISSUE_COPY: Record<string, UiKey> = {
  'content.publish.locale-not-in-document': 'admin.content.issue.localeNotInDocument',
  'content.publish.locale-not-in-item': 'admin.content.issue.localeNotInDocument',
  'content.publish.missing-translation': 'admin.content.issue.missingTranslation',
  'content.publish.machine-translation-unreviewed': 'admin.assist.unreviewed',
  'content.publish.teaser-lead-required': 'admin.content.issue.teaserLeadRequired',
  'content.publish.tier-unverifiable': 'admin.content.issue.tierUnverifiable',
  'content.reference.author-unknown': 'admin.content.issue.referenceUnknown',
  'content.reference.section-unknown': 'admin.content.issue.referenceUnknown',
  'content.reference.item-unknown': 'admin.content.issue.referenceUnknown',
  'content.reference.form-unknown': 'admin.content.issue.referenceUnknown',
  'content.reference.media-unknown': 'admin.content.issue.referenceUnknown',
  'content.reference.media-not-image': 'admin.content.issue.mediaNotImage',
  'content.schedule.not-in-future': 'admin.content.issue.notInFuture',
  'admin.content.publication.time-invalid': 'admin.content.issue.timeInvalid',
};
const issueCopy = (message: string): UiKey =>
  ISSUE_COPY[issueKey(message)] ?? 'admin.content.issue.other';

/**
 * One publication action on one locale (brief content-editor § A2). Core decides: `content:publish`
 * through the registry (a member without it gets a 403 whatever the page showed), readiness and
 * references on publish and schedule. A refusal names the locale and every issue with its path.
 */
async function publication(
  event: Parameters<Actions[string]>[0],
  action: keyof typeof DONE,
  run: (
    principal: Principal,
    input: { itemId: string; locale: string; revisionId: string; at: string }
  ) => Promise<unknown>,
  posted?: FormData
) {
  const { tenant, principal } = await requireTenantPrincipal(
    event.locals,
    event.url,
    event.params.tenant!
  );
  const data = posted ?? (await event.request.formData());
  const field = (name: string) => {
    const v = data.get(name);
    return typeof v === 'string' ? v : '';
  };
  const locale = field('locale');
  try {
    await run(principal, {
      itemId: event.params.itemId!,
      locale,
      revisionId: field('revisionId'),
      at: field('at'),
    });
  } catch (e) {
    if (!(e instanceof UseCaseError)) throw e;
    const { status, body } = failureOf(e, action, {
      conflict: 'admin.content.error.invalid',
      invalid: 'admin.content.publication.error.refused',
      issues: { 'content.schedule.not-in-future': 'admin.content.issue.notInFuture' },
    });
    return fail(status, {
      ...body,
      locale,
      issues:
        e.code === 'invalid_input'
          ? e.issues.map((i) => ({
              path: issuePath(i.path, i.message, locale),
              field: fieldOf(i.path, locale),
              copy: issueCopy(i.message),
            }))
          : [],
    });
  }
  redirect(
    303,
    `/admin/${tenant.slug}/content/${event.params.itemId}?done=${action}&locale=${encodeURIComponent(locale)}`
  );
}

/** The time of the schedule form, or a refusal core will word like its own. */
function instant(at: string): string {
  const parsed = fromLocalInput(at);
  if (!parsed)
    throw new UseCaseError('invalid_input', 'no time given', [
      { path: 'at', message: 'admin.content.publication.time-invalid' },
    ]);
  return parsed.toISOString();
}

/** Core's issue keys on a save, as admin copy; anything else is the generic invalid message. */
const ISSUES: Record<string, UiKey> = {
  'i18n.default-not-in-locales': 'admin.content.error.defaultLocale',
  'content.seo.canonical.invalid': 'admin.content.error.canonical',
  'content.tag.invalid': 'admin.content.error.tag',
  'content.access.marker-needs-one-paywall': 'admin.content.error.marker',
  'content.access.teaser-too-long': 'admin.content.error.teaserTooLong',
  'content.access.tier-ids-required': 'admin.content.error.tier',
};

/**
 * One block action on the revision the page showed (brief content-editor § B). `apply` gets the
 * block and its index in that revision and runs the operation; a refusal comes back with what was
 * typed and the issues on their fields, a stale revision as the conflict of A1.
 */
async function blockAction(
  event: Parameters<Actions[string]>[0],
  done: string,
  apply: (input: {
    principal: Principal;
    data: FormData;
    blocks: ContentDocument['blocks'];
    index: number;
    target: { itemId: string; baseRevisionId: string };
  }) => Promise<FieldIssue[] | void>
) {
  const { tenant, principal } = await requireTenantPrincipal(
    event.locals,
    event.url,
    event.params.tenant!
  );
  const data = await event.request.formData();
  const blockId = text(data, 'blockId');
  const target = { itemId: event.params.itemId!, baseRevisionId: text(data, 'baseRevisionId') };
  const blockValues: Record<string, string> = {};
  for (const [k, v] of data) if (typeof v === 'string' && !(k in blockValues)) blockValues[k] = v;
  const rt = runtime();
  let index = -1;
  try {
    const { revision } = await rt.invoker.run(useCases.getItem, principal, {
      itemId: target.itemId,
      revisionId: target.baseRevisionId,
    });
    const blocks = revision.document.blocks;
    index = blocks.findIndex((b) => b.id === blockId);
    if (index < 0) error(404, 'Not found');
    // Rich text the form could not read never reaches core.
    const unread = await apply({ principal, data, blocks, index, target });
    if (unread?.length)
      return fail(400, {
        action: 'block',
        error: 'admin.block.error.invalid' as UiKey,
        blockId,
        blockValues,
        fieldIssues: unread,
        conflict: null,
      });
  } catch (e) {
    if (!(e instanceof UseCaseError)) throw e;
    const { status, body } = failureOf(e, 'block', {
      conflict: 'admin.content.conflict.title',
      invalid: 'admin.block.error.invalid',
    });
    const conflict =
      e.code === 'conflict'
        ? await conflictOf(principal, target.itemId, target.baseRevisionId)
        : null;
    return fail(status, {
      ...body,
      blockId,
      blockValues: conflict ? { ...blockValues, baseRevisionId: conflict.newest } : blockValues,
      fieldIssues: e.code === 'invalid_input' ? fieldIssues(e, index) : [],
      conflict: conflict && { who: conflict.who, when: conflict.when, changes: conflict.changes },
    });
  }
  redirect(
    303,
    `/admin/${tenant.slug}/content/${target.itemId}?done=${done}&block=${encodeURIComponent(blockId)}#block-${blockId}`
  );
}

/** Who saved the newest revision, when, and what changed since `from`. */
async function conflictOf(principal: Principal, itemId: string, from: string) {
  const { item, revision } = await latest(principal, itemId);
  const { changes } = await runtime().invoker.run(useCases.diffRevisions, principal, {
    itemId: item.id,
    fromRevisionId: from,
    toRevisionId: revision.id,
  });
  return {
    newest: revision.id,
    who: actorLabel(revision.actor),
    when: when(revision.createdAt),
    changes: diffRows(changes),
  };
}

/**
 * Saves the edit form as a new revision (brief content-editor § A1). `onlyIfChanged` is the
 * publish button of the same form (editor trial 2026-10-28): it saves first so a publish never skips what was
 * typed, but an untouched form adds no empty revision. A refusal is the page's own failure.
 */
async function saveFields(
  tenant: TenantInfo,
  principal: Principal,
  itemId: string,
  values: FormValues,
  onlyIfChanged: boolean
) {
  const baseRevisionId = typeof values.baseRevisionId === 'string' ? values.baseRevisionId : '';
  const rt = runtime();
  let base: ContentDocument;
  try {
    const got = await rt.invoker.run(useCases.getItem, principal, {
      itemId,
      revisionId: baseRevisionId,
    });
    base = got.revision.document;
    const today = rt.clock.now().toISOString().slice(0, 10);
    const document = documentFrom(base, values, today);
    if (onlyIfChanged && isDeepStrictEqual(document, documentFrom(base, valuesOf(base), today)))
      return { revisionId: baseRevisionId };
    const saved = await rt.invoker.run(useCases.updateItem, principal, {
      itemId,
      baseRevisionId,
      document,
    });
    return { revisionId: saved.revision.id };
  } catch (e) {
    if (!(e instanceof UseCaseError)) throw e;
    const { status, body } = failureOf(e, 'save', {
      conflict: 'admin.content.conflict.title',
      invalid: 'admin.content.error.invalid',
      issues: ISSUES,
    });
    const { item, revision } = await latest(principal, itemId);
    const choices = await relationshipChoices(
      principal,
      tenant.defaultLocale,
      revision.document.type === 'article',
      Array.isArray(values.authorIds) ? [...new Set(values.authorIds)] : [],
      typeof values.sectionId === 'string' ? values.sectionId : ''
    );
    if (e.code !== 'conflict')
      return { failure: fail(status, { ...body, ...choices, values, conflict: null }) };
    const { changes } = await rt.invoker.run(useCases.diffRevisions, principal, {
      itemId: item.id,
      fromRevisionId: baseRevisionId,
      toRevisionId: revision.id,
    });
    return {
      failure: fail(status, {
        ...body,
        ...choices,
        values: { ...values, baseRevisionId: revision.id },
        conflict: {
          who: actorLabel(revision.actor),
          when: when(revision.createdAt),
          changes: diffRows(changes),
        },
      }),
    };
  }
}

export const actions: Actions = {
  setProps: (event) =>
    blockAction(event, 'blockSaved', async ({ principal, data, blocks, index, target }) => {
      const block = blocks[index]!;
      const { props, errors } = propsFromForm(
        BLOCK_DEFINITIONS[block.type].fields,
        posted(data),
        block.props as Record<string, unknown>
      );
      if (errors.length)
        return errors.map((e) => ({ name: e.name, copy: blockIssueCopy(e.message) }));
      await runtime().invoker.run(useCases.setBlockProps, principal, {
        ...target,
        blockId: block.id,
        props,
      });
    }),
  move: (event) =>
    blockAction(event, 'blockMoved', async ({ principal, data, blocks, index, target }) => {
      const up = text(data, 'direction') === 'up';
      const neighbour = blocks[up ? index - 1 : index + 1];
      if (!neighbour) return;
      await runtime().invoker.run(useCases.moveBlock, principal, {
        ...target,
        blockId: blocks[index]!.id,
        place: up ? { before: neighbour.id } : { after: neighbour.id },
      });
    }),
  publish: async (event) => {
    const posted = await event.request.formData();
    // The publish button of the edit form carries its fields: save them first (editor trial 2026-10-28).
    if (posted.has('baseRevisionId')) {
      const { locals, url, params } = event;
      const { tenant, principal } = await requireTenantPrincipal(locals, url, params.tenant);
      // Without the right to publish, nothing is saved on the way to a refusal.
      if (!can(principal, 'content:publish')) error(403, 'Forbidden');
      const saved = await saveFields(
        tenant,
        principal,
        params.itemId,
        valuesFromForm(posted),
        true
      );
      if ('failure' in saved) return saved.failure;
      posted.set('revisionId', saved.revisionId);
    }
    return publication(
      event,
      'publish',
      (principal, { itemId, locale, revisionId }) =>
        runtime().invoker.run(useCases.publishItem, principal, { itemId, locale, revisionId }),
      posted
    );
  },
  unpublish: (event) =>
    publication(event, 'unpublish', (principal, { itemId, locale }) =>
      runtime().invoker.run(useCases.unpublishItem, principal, { itemId, locale })
    ),
  schedule: (event) =>
    publication(event, 'schedule', async (principal, { itemId, locale, revisionId, at }) =>
      runtime().invoker.run(useCases.scheduleItem, principal, {
        itemId,
        locale,
        revisionId,
        at: instant(at),
      })
    ),
  repin: (event) =>
    publication(event, 'repin', async (principal, { itemId, locale, revisionId }) => {
      if (!can(principal, 'content:publish'))
        throw new UseCaseError('forbidden', 'missing capability content:publish');
      const { item } = await runtime().invoker.run(useCases.getItem, principal, { itemId });
      const at = item.publication.find((state) => state.locale === locale)?.scheduledFor;
      if (!at)
        throw new UseCaseError('invalid_input', 'no schedule to replace', [
          { path: 'at', message: 'admin.content.publication.time-invalid' },
        ]);
      return runtime().invoker.run(useCases.scheduleItem, principal, {
        itemId,
        locale,
        revisionId,
        at,
      });
    }),
  unschedule: (event) =>
    publication(event, 'unschedule', (principal, { itemId, locale }) =>
      runtime().invoker.run(useCases.unscheduleItem, principal, { itemId, locale })
    ),
  approveTranslation: async ({ locals, url, params, request }) => {
    const { tenant, principal } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'content:publish'))
      error(403, ui(locals.lang ?? 'en')('admin.assist.error.forbidden'));
    const data = await request.formData();
    const locale = text(data, 'locale');
    try {
      await runtime().invoker.run(useCases.approveTranslation, principal, {
        itemId: params.itemId,
        locale,
        baseRevisionId: text(data, 'baseRevisionId'),
      });
    } catch (e) {
      if (!(e instanceof UseCaseError)) throw e;
      return fail(e.code === 'conflict' ? 409 : 400, {
        action: 'approveTranslation',
        error: (e.code === 'conflict'
          ? 'admin.assist.error.conflict'
          : 'admin.assist.error.invalid_input') as UiKey,
      });
    }
    redirect(
      303,
      `/admin/${tenant.slug}/content/${params.itemId}?done=translationApproved&locale=${encodeURIComponent(locale)}`
    );
  },
  save: async ({ locals, url, params, request }) => {
    const { tenant, principal } = await requireTenantPrincipal(locals, url, params.tenant);
    const values = valuesFromForm(await request.formData());
    const saved = await saveFields(tenant, principal, params.itemId, values, false);
    if ('failure' in saved) return saved.failure;
    redirect(303, `/admin/${tenant.slug}/content/${params.itemId}?saved`);
  },
};
