// The edit screen of one item (TODO #66 PR 2, brief edit-screen § 6): one form for the whole
// document. Its fields, every block's fields (`lib/server/edit-form.ts`) and a block chosen but
// not stored yet are saved together as one `content.item.update` with the revision the form was
// opened on as `baseRevisionId` (ADR 018 rule 2); every other action of the screen (publish,
// schedule, move, remove, insert, duplicate) is a button of the same form that saves first and
// then runs its own use case on the revision that save made, so no action loses what was typed. Authors and
// section always list what the document or a failed post has, also beyond the first page of the
// directory (`withAssigned`).
//
// A conflict shows both versions, as the ADR asks: the form keeps what was typed, a notice names
// who saved the newer revision and when, and a table lists what changed between the revision the
// form was opened on and the newest. The form then carries the newest id, so saving again is a
// deliberate choice to put these values on top. Rejected: last-write-wins with a warning, and a
// silent merge (which field wins is the editor's call, not ours).
//
// The status card (brief § 4) acts per locale: publish, take offline, schedule (a time in the site
// zone, `content-admin-publication.ts`) and cancel a schedule; pinning the newest revision is a
// schedule of it at the pinned time. Buttons show only for `content:publish`, and a member
// without it is refused before anything is saved; the registry refuses the rest regardless.
//
// One locale at a time (#66 PR 4): the screen shows the content locale (`content-locale.ts`) and
// carries it as `editLocale`; a save reads only that locale and keeps every other one as the base
// revision has it (`formDocument`). Switching locale saves first and remembers the choice; a
// locale the document lacks shows "start the translation", empty or as a copy of another locale.
import { toArticleEditor } from '#lib/editor/article-document.js';
import { isDeepStrictEqual } from 'node:util';
import { error, fail, redirect } from '@sveltejs/kit';
import {
  pick,
  BLOCK_DEFINITIONS,
  BLOCK_TYPES,
  UseCaseError,
  can,
  contentPath,
  documentMedia,
  readinessIssues,
  useCases,
  type BlockInput,
  type ContentDocument,
  type Principal,
  type Section,
  type TenantInfo,
} from '@mycel/core';
import { formValues, posted, type Posted } from '#lib/editor/block-form.js';
import { failureOf, text } from '#lib/server/admin/admin-actions.js';
import { adminTimeZone, requireTenantPrincipal } from '#lib/server/admin/admin.js';
import {
  actorLabel,
  diffRows,
  valuesFromForm,
  type FormValues,
  withAssigned,
  withLocale,
  valuesOf,
  when,
} from '#lib/server/content-admin.js';
import {
  chooseContentLocale,
  contentLocale,
  translationState,
} from '#lib/server/content-locale.js';
import {
  fieldOf,
  fromLocalInput,
  issuePath,
  localInput,
  localLabel,
} from '#lib/server/content-admin-publication.js';
import {
  issueCopy as blockIssueCopy,
  pickerOptions,
  imageRestOf,
  previewOf,
  summaryOf,
} from '#lib/server/content-blocks.js';
import {
  NEW_BLOCK,
  blockIssues,
  documentFieldIssues,
  blockPrefix,
  formDocument,
  pendingBlock,
  pendingProps,
  pendingView,
  type PendingBlock,
} from '#lib/server/edit-form.js';
import { runtime } from '#lib/server/runtime.js';
import { adminSiteUrls } from '#lib/server/site.js';
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

/** A post without block fields: the document as stored, to tell a change from none. */
const unposted: Posted = { get: () => null, names: () => [] };

/** Form values under a name prefix. */
const prefixed = (values: Record<string, string>, prefix: string): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [`${prefix}${k}`, v]));

/**
 * The edit screen's address: the item, whatever the redirect adds, and the locale when it is
 * not the one the screen shows anyway.
 */
const itemPath = (
  tenant: string,
  itemId: string,
  locale: string | null | undefined,
  query: Record<string, string> = {},
  hash = ''
) => {
  const q = new URLSearchParams({ ...query, ...(locale ? { locale } : {}) });
  // `saved` is a flag without a value, as the screen reads it.
  const search = q.toString().replace(/(^|&)saved=(?=&|$)/, '$1saved');
  return `/admin/${tenant}/content/${itemId}${search ? `?${search}` : ''}${hash ? `#${hash}` : ''}`;
};

export const load: PageServerLoad = async ({ parent, locals, params, url, cookies }) => {
  const { tenant } = await parent();
  const principal = locals.principal!;
  const { zone, site } = await adminTimeZone(locals);
  const { item, revision, effective } = await latest(principal, params.itemId);
  const doc = revision.document;
  // The site's locales first, then any the document has that the site no longer does.
  const locales = [...new Set([...tenant.locales, ...doc.locales])];
  const work = contentLocale(cookies, tenant, url.searchParams.get('locale'), locales);
  // The fields of one locale only; none while the document lacks it (start the translation).
  const shown = doc.locales.includes(work) ? [work] : [];
  const read = shown[0] ?? item.defaultLocale;
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
          when: when(r.createdAt, zone),
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
    // The images the chain shows under an empty picker (the site's default too), so each has
    // its thumbnail even when it is not among the newest.
    [
      ...documentMedia(doc).map((m) => m.mediaId),
      ...Object.values(effective).flatMap((e) =>
        [e.images.featured.mediaId, e.images.share.mediaId].filter((id) => id !== null)
      ),
    ]
  );
  const canWrite = can(principal, 'content:write');
  const pending = pendingBlock(
    url.searchParams.get('insert'),
    url.searchParams.get('place'),
    url.searchParams.get('anchor'),
    doc.blocks.map((b) => b.id)
  );
  const siteUrl = item.publication.some((p) => p.publishedRevisionId)
    ? await adminSiteUrls(principal, tenant.slug)
    : null;
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
    patterns: doc.blocks.length
      ? []
      : (await invoker.run(useCases.listPatterns, principal, { limit: 100 })).patterns
          .filter((p) => !p.intendedType || p.intendedType === item.type)
          .map((p) => ({ id: p.id, name: pick(p.name, work, tenant.defaultLocale) ?? p.id })),
    articleEditor: shown.length ? toArticleEditor(doc, work) : null,
    assistEnabled,
    machineTranslation: doc.machineTranslation ?? {},
    blocks: doc.blocks.map((b) => ({
      id: b.id,
      type: b.type,
      summary: summaryOf(b, read),
      preview: previewOf(b, read),
      image: imageRestOf(b, read, options.media),
      duplicable: !SINGLE.has(b.type),
      // The other locales a text block has, to translate the shown one from (AI help).
      translatable:
        b.type === 'rich-text' && shown.length
          ? doc.locales.filter(
              (l) => l !== work && (b.props as { content: Record<string, unknown> }).content[l]
            )
          : [],
      values: prefixed(
        formValues(BLOCK_DEFINITIONS[b.type].fields, b.props as Record<string, unknown>, shown),
        blockPrefix(b.id)
      ),
    })),
    openBlocks: (url.searchParams.get('block') ?? '').split(','),
    blockTypes: BLOCK_TYPES,
    pending: canWrite && pending && shown.length ? pendingView(pending, shown) : null,
    docLocales: doc.locales,
    /** The one locale the screen shows and saves (#66 PR 4). */
    workLocale: work,
    /** The document lacks the content locale: the screen offers to start the translation. */
    translating: !shown.length,
    /** Every locale of the site with where its translation stands, for the switch. */
    translations: locales.map((l) => ({ locale: l, state: translationState(doc, l) })),
    /** The shell's own locale switch steps aside: the item's bar switches, and saves first. */
    itemLocale: true,
    ...options,
    item: {
      id: item.id,
      type: item.type,
      slug: item.slug,
      /** The address in the site's default locale, as the public site serves it. */
      path: contentPath(item, tenant.defaultLocale, tenant.defaultLocale),
      /** A locale went live once: the slug stays (`content.slug.update`). */
      slugFixed: item.publication.some((p) => p.firstPublishedAt !== null),
      defaultLocale: item.defaultLocale,
      publication: await Promise.all(
        item.publication.map(async (p) => ({
          locale: p.locale,
          status: p.status,
          changes: p.hasUnpublishedChanges,
          publishedAt: p.publishedAt,
          href:
            siteUrl && p.publishedRevisionId
              ? siteUrl(contentPath(item, p.locale, tenant.defaultLocale))
              : null,
          live: p.publishedRevisionId ? await describe(p.publishedRevisionId) : null,
          pin:
            p.scheduledRevisionId && p.scheduledFor
              ? {
                  at: localLabel(new Date(p.scheduledFor), zone, zone !== site),
                  input: localInput(new Date(p.scheduledFor), zone),
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
    canWrite,
    restricted: doc.access.level !== 'public',
    // Readers (#19) do not exist yet: access shows only on an item that already has it.
    showAccess: doc.access.level !== 'public',
    timeZone: zone,
    // Named next to the field only where the operator's own zone is not the site's (#88).
    timeZoneNamed: zone !== site,
    done: DONE[url.searchParams.get('done') ?? ''] ?? null,
    // "Undo" after a removal: `<revision>:<block>`, posted back as is to `restore`.
    undo:
      canWrite && url.searchParams.get('done') === 'blockRemoved'
        ? (url.searchParams.get('undo') ?? null)
        : null,
    doneLocale: url.searchParams.get('locale') ?? '',
    revision: {
      id: revision.id,
      when: when(revision.createdAt, zone),
      who: actorLabel(revision.actor),
    },
    corrections: doc.type === 'article' ? doc.corrections : [],
    values: valuesOf(doc),
    // What every empty field inherits, per locale, with its source (#86): `Inherited` shows it.
    effective,
    locales,
    authors,
    sections,
    saved: url.searchParams.has('saved'),
    /**
     * Where static/_admin/session-restore.js keeps unsaved input through a login: this site,
     * this operator, this item, this locale. The operator is the signed-in one, never input.
     */
    restore: canWrite ? `${tenant.slug}:${locals.session!.operatorId}:${item.id}:${work}` : null,
    operatorId: canWrite ? locals.session!.operatorId : null,
  };
};

/**
 * Blocks a copy right after the original could never stand: two text blocks side by side merge
 * (`content.blocks.adjacent-rich-text`) and a document has one paywall marker.
 */
const SINGLE = new Set<string>(['rich-text', 'paywall']);

/** The notice after a publication action, by the `done` parameter of its redirect. */
const DONE: Record<string, UiKey> = {
  blockMoved: 'admin.block.done.moved',
  blockDuplicated: 'admin.block.done.duplicated',
  blockRemoved: 'admin.block.done.removed',
  blockRestored: 'admin.block.done.restored',
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
const issueCopy = (message: string): UiKey => ISSUE_COPY[message] ?? 'admin.content.issue.other';

/** The time of the schedule form, or a refusal core will word like its own. */
function instant(at: string, zone: string): string {
  const parsed = fromLocalInput(at, zone);
  if (!parsed)
    throw new UseCaseError('invalid_input', 'no time given', [
      { path: 'at', message: 'admin.content.publication.time-invalid' },
    ]);
  return parsed.toISOString();
}

/** The operator's admin language; the admin hook always sets it, English only as a last resort. */
const adminUi = (locals: App.Locals) => ui(locals.lang ?? 'en');

/** Core's issue keys on a save, as admin copy; anything else is the generic invalid message. */
const ISSUES: Record<string, UiKey> = {
  'i18n.default-not-in-locales': 'admin.content.error.defaultLocale',
  'content.seo.canonical.invalid': 'admin.content.error.canonical',
  'content.tag.invalid': 'admin.content.error.tag',
  'content.access.marker-needs-one-paywall': 'admin.content.error.marker',
  'content.access.teaser-too-long': 'admin.content.error.teaserTooLong',
  'content.access.tier-ids-required': 'admin.content.error.tier',
};

/** A refused save as admin copy, with the narrowed error; anything that is not a use-case
 *  refusal is rethrown. Shared by the form's save and the translation start. */
function saveFailure(e: unknown) {
  if (!(e instanceof UseCaseError)) throw e;
  const { status, body } = failureOf(e, 'save', {
    conflict: 'admin.content.conflict.title',
    invalid: 'admin.content.error.invalid',
    issues: ISSUES,
  });
  return { error: e, status, body };
}

/**
 * Who saved the newest revision, when, and what changed since `from`. The slug lives on the item,
 * not in a revision, so a moved address is its own row when the form says what it was rendered
 * with (`baseSlug`); without it a conflict over a moved address read "No differences".
 */
async function conflictOf(
  principal: Principal,
  itemId: string,
  from: string,
  zone: string,
  baseSlug?: string
) {
  const { item, revision } = await latest(principal, itemId);
  const { changes } = await runtime().invoker.run(useCases.diffRevisions, principal, {
    itemId: item.id,
    fromRevisionId: from,
    toRevisionId: revision.id,
  });
  const moved = baseSlug !== undefined && baseSlug !== item.slug;
  return {
    newest: revision.id,
    slug: item.slug,
    who: actorLabel(revision.actor),
    when: when(revision.createdAt, zone),
    changes: diffRows(
      moved ? [{ path: 'slug', before: baseSlug, after: item.slug }, ...changes] : changes
    ),
  };
}

type Event = Parameters<Actions[string]>[0];

/** What a successful save of the one form hands to the action that follows it. */
interface Committed {
  tenant: TenantInfo;
  principal: Principal;
  data: FormData;
  /** The revision the action runs on: the save's, or the one the form was opened on. */
  revisionId: string;
  /** The block the save inserted, if a pending one was in the form. */
  inserted: string | null;
  /** The blocks whose fields the save changed, so the screen comes back with them open. */
  changed: string[];
  /** The admin's time zone for this request (`adminTimeZone`). */
  zone: string;
  /**
   * The locale the form showed (`editLocale`) when the screen must name it to come back in it:
   * null when it is the operator's content locale anyway.
   */
  editing: string | null;
}

/** Core's refusals of a new slug, as admin copy. */
const SLUG_ISSUES: Record<string, UiKey> = {
  'content.slug.invalid': 'admin.content.error.slugInvalid',
  'content.slug.reserved': 'admin.content.error.slugReserved',
  'content.slug.taken': 'admin.content.error.slugTaken',
  'content.slug.published': 'admin.content.error.slugPublished',
};

/**
 * The slug the form was rendered with (`baseSlug`, next to the field), so a tab that never touched
 * the field cannot move the address back after another tab moved it. A form without it (an older
 * tab) compares with the item's slug, as before. Rejected: comparing with `item.slug` only, which
 * read a stale tab's untouched field as a request to restore the old address.
 */
function baseSlugOf(item: { slug: string }, data: FormData): string {
  return data.has('baseSlug') ? text(data, 'baseSlug') : item.slug;
}

/** The new slug the form asks for, or null: empty, untouched, already the item's, or no field. */
function slugChange(item: { slug: string }, data: FormData): string | null {
  const slug = text(data, 'slug').trim();
  return slug && slug !== baseSlugOf(item, data) && slug !== item.slug ? slug : null;
}

/**
 * The form values a conflict comes back with: the newest revision as base and the item's slug as
 * `baseSlug`. An untouched slug field follows the item, so the next save keeps the address the
 * other tab gave it; a slug the operator typed stays, to be applied by that save.
 */
function conflictValues(values: FormValues, newest: string, slug: string): FormValues {
  const untouched = !('slug' in values) || values.slug === values.baseSlug;
  return {
    ...values,
    baseRevisionId: newest,
    ...('baseSlug' in values ? { baseSlug: slug } : {}),
    ...('slug' in values && untouched ? { slug } : {}),
  };
}

/**
 * The slug field of "This item" (#66 PR 6b), applied after the base check and the form's own
 * checks and just before the revision is saved: a refused slug then leaves everything as it was
 * and the form comes back with what was typed. The slug lives on the item, not in a revision, so
 * the save that follows keeps its base. The two are separate transactions: a revision core still
 * refuses after the slug moved (a concurrent save in between, a document rule only core knows)
 * leaves the slug moved, which the next save shows. Rejected: one combined use case, which would
 * make every revision save a slug write too. Empty, or a form without the field (an item that
 * was published, an older tab), changes nothing.
 */
async function moveSlug(
  principal: Principal,
  item: { id: string; slug: string },
  data: FormData
): Promise<{ error: UiKey; status: number; fieldIssues: { name: string; copy: UiKey }[] } | null> {
  const slug = slugChange(item, data);
  if (!slug) return null;
  try {
    await runtime().invoker.run(useCases.updateSlug, principal, { itemId: item.id, slug });
    return null;
  } catch (thrown) {
    const { error: e } = saveFailure(thrown);
    if (e.code !== 'conflict' && e.code !== 'invalid_input') throw e;
    const key = e.issues.map((i) => SLUG_ISSUES[i.message]).find(Boolean);
    const copy =
      key ??
      (e.code === 'conflict' ? 'admin.content.error.slugTaken' : 'admin.content.error.slugInvalid');
    // The summary's line names the field and says why; the heading is the save's.
    return {
      error: 'admin.content.error.invalid',
      status: e.code === 'conflict' ? 409 : 400,
      fieldIssues: [{ name: 'slug', copy }],
    };
  }
}

/**
 * Saves what the one form carries before any action of the screen (brief edit-screen § 6): the
 * document's fields and every block's as one `content.item.update` on the revision the form was
 * opened on, then a pending block through `content.block.insert`. Only `always` (the save button)
 * adds a revision for an untouched form, as before; any other action saves only a change, and a
 * member without `content:write` changes nothing on the way to an action they may do. The block
 * being removed keeps its stored props, so an unfinished block can always be thrown away.
 * `publication` refuses a member without `content:publish` before anything is saved.
 */
async function commit(
  event: Event,
  opts: { always?: boolean; publication?: boolean; discard?: boolean; pattern?: boolean } = {}
): Promise<Committed | { failure: Awaited<ReturnType<typeof refused>> }> {
  const { tenant, principal } = await requireTenantPrincipal(
    event.locals,
    event.url,
    event.params.tenant!
  );
  if (opts.publication && !can(principal, 'content:publish')) error(403, 'Forbidden');
  const { zone } = await adminTimeZone(event.locals);
  const data = await event.request.formData();
  const itemId = event.params.itemId!;
  const baseRevisionId = text(data, 'baseRevisionId');
  // The one locale the form shows; a form without the field (an older tab) carries them all.
  const editing = data.has('editLocale') ? text(data, 'editLocale') || null : undefined;
  let changed: string[] = [];
  const done = (revisionId: string, inserted: string | null = null): Committed => ({
    tenant,
    principal,
    data,
    revisionId,
    inserted,
    changed,
    zone,
    editing: editing && editing !== contentLocale(event.cookies, tenant) ? editing : null,
  });
  if (!opts.always && !can(principal, 'content:write')) return done(baseRevisionId);
  const values = valuesFromForm(data);
  const post = posted(data);
  const rt = runtime();
  let blocks: readonly { id: string }[] = [];
  let pending: PendingBlock | null = null;
  let revisionId = baseRevisionId;
  // The address this save moved the item to, once that transaction stood (`moveSlug`).
  let movedTo: string | null = null;
  try {
    const { item, revision } = await rt.invoker.run(useCases.getItem, principal, {
      itemId,
      revisionId: baseRevisionId,
    });
    // A stale tab moves nothing: its slug change is part of the conflict like its fields are,
    // also when only the address moved since the form was rendered (no newer revision then).
    if (
      slugChange(item, data) &&
      (item.latestRevisionId !== baseRevisionId || item.slug !== baseSlugOf(item, data))
    )
      throw new UseCaseError('conflict', 'the item has a newer revision than baseRevisionId');
    const base = revision.document;
    blocks = base.blocks;
    pending = opts.discard
      ? null
      : pendingBlock(
          text(data, `${NEW_BLOCK}type`),
          text(data, `${NEW_BLOCK}place`),
          text(data, `${NEW_BLOCK}anchor`),
          base.blocks.map((b) => b.id)
        );
    const today = rt.clock.now().toISOString().slice(0, 10);
    const read = formDocument(
      base,
      values,
      post,
      today,
      editing,
      text(data, 'remove') || undefined
    );
    const added = pending && pendingProps(pending, post);
    // Rich text the form could not read never reaches core.
    const unread = [...read.errors, ...(added?.errors ?? [])];
    if (unread.length)
      return {
        failure: await refused(tenant, principal, itemId, values, pending, {
          error: 'admin.block.error.invalid',
          fieldIssues: unread.map((e) => ({ name: e.name, copy: blockIssueCopy(e.message) })),
        }),
      };
    changed = read.blocks.filter((b, i) => !isDeepStrictEqual(b, base.blocks[i])).map((b) => b.id);
    const document = read.document;
    if (opts.pattern) {
      if (base.blocks.length || read.blocks.length)
        throw new UseCaseError('conflict', 'Pattern requires an empty document');
      const pattern = await rt.invoker.run(useCases.getPattern, principal, {
        patternId: text(data, 'patternId'),
      });
      document.blocks = pattern.blocks.map(({ id: _id, ...block }) => block);
    }
    const moved = await moveSlug(principal, item, data);
    if (moved)
      return {
        failure: await refused(tenant, principal, itemId, values, null, moved),
      };
    movedTo = slugChange(item, data);
    const untouched = formDocument(base, valuesOf(base), unposted, today, editing).document;
    if (opts.always || !isDeepStrictEqual(document, untouched))
      revisionId = (
        await rt.invoker.run(useCases.updateItem, principal, { itemId, baseRevisionId, document })
      ).revision.id;
    if (!pending || !added) return done(revisionId);
    const result = await rt.invoker.run(useCases.insertBlock, principal, {
      itemId,
      baseRevisionId: revisionId,
      block: {
        type: pending.type,
        version: BLOCK_DEFINITIONS[pending.type].version,
        props: added.props,
      } as BlockInput,
      place: pending.place,
    });
    return done(result.revision.id, result.created[0] ?? null);
  } catch (thrown) {
    const { error: e, status, body } = saveFailure(thrown);
    const onBlocks = e.code === 'invalid_input' ? blockIssues(e, blocks) : [];
    // A document field (canonical, tags, access, locales) is named too: it may sit on a tab
    // that is not shown, and the summary's link is the way to it.
    const onFields = e.code === 'invalid_input' ? documentFieldIssues(e) : [];
    // A refused insert comes after a save that stood: the form now edits that revision. A moved
    // address stood too (its own transaction), so the form is based on it, as `conflictValues`
    // does; on the old one, moving the address back would read as untouched (#208 review, F2).
    const saved = {
      ...values,
      baseRevisionId: revisionId,
      ...(movedTo && 'baseSlug' in values ? { baseSlug: movedTo } : {}),
    };
    if (e.code !== 'conflict')
      return {
        failure: await refused(tenant, principal, itemId, saved, pending, {
          ...body,
          ...(onFields.length
            ? { error: 'admin.content.error.invalid' as UiKey }
            : onBlocks.length
              ? { error: 'admin.block.error.invalid' as UiKey }
              : {}),
          fieldIssues: [
            ...onFields.map((i) => ({ name: i.name, copy: ISSUES[i.message] ?? body.error })),
            ...onBlocks.map((i) => ({ name: i.name, copy: blockIssueCopy(i.message) })),
          ],
          status,
        }),
      };
    const conflict = await conflictOf(
      principal,
      itemId,
      baseRevisionId,
      zone,
      data.has('baseSlug') ? text(data, 'baseSlug') : undefined
    );
    return {
      failure: await refused(
        tenant,
        principal,
        itemId,
        conflictValues(values, conflict.newest, conflict.slug),
        pending,
        {
          ...body,
          status,
          conflict: { who: conflict.who, when: conflict.when, changes: conflict.changes },
        }
      ),
    };
  }
}

/**
 * The failure of a save: what was typed, the pending block, the refused fields and the choices
 * the authors and section fields need to show what was posted.
 */
async function refused(
  tenant: TenantInfo,
  principal: Principal,
  itemId: string,
  values: FormValues,
  pending: PendingBlock | null,
  outcome: {
    error: UiKey;
    status?: number;
    fieldIssues?: { name: string; copy: UiKey }[];
    conflict?: { who: string; when: string; changes: ReturnType<typeof diffRows> };
    [key: string]: unknown;
  }
) {
  const { revision } = await latest(principal, itemId);
  const choices = await relationshipChoices(
    principal,
    tenant.defaultLocale,
    revision.document.type === 'article',
    Array.isArray(values.authorIds) ? [...new Set(values.authorIds)] : [],
    typeof values.sectionId === 'string' ? values.sectionId : ''
  );
  const { status = 400, ...rest } = outcome;
  return fail(status, {
    action: 'save',
    ...rest,
    ...choices,
    values,
    pending: pending && pendingView(pending, revision.document.locales, values),
    fieldIssues: outcome.fieldIssues ?? [],
    conflict: outcome.conflict ?? null,
  });
}

/**
 * One publication action on one locale (brief content-editor § A2) after the save of the form.
 * Core decides: `content:publish` through the registry (a member without it gets a 403 whatever
 * the page showed), readiness and references on publish and schedule. A refusal names the
 * locale and every issue with its path.
 */
async function publication(
  event: Event,
  action: keyof typeof DONE,
  run: (
    principal: Principal,
    input: { itemId: string; locale: string; revisionId: string; at: string }
  ) => Promise<unknown>
) {
  const saved = await commit(event, { publication: true });
  if ('failure' in saved) return saved.failure;
  const { tenant, principal, data, revisionId } = saved;
  const locale = text(data, 'locale');
  try {
    await run(principal, {
      itemId: event.params.itemId!,
      locale,
      revisionId,
      at: text(data, `at.${locale}`),
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
  redirect(303, itemPath(tenant.slug, event.params.itemId!, locale, { done: action }));
}

/**
 * Runs a block operation; a use-case refusal comes back as the screen's failure (a conflict with
 * who saved in between), anything else is thrown. Shared by `blockStep` and `restore`.
 */
async function blockTry(saved: Committed, itemId: string, run: () => Promise<void>) {
  const { principal, revisionId, zone } = saved;
  try {
    await run();
    return null;
  } catch (e) {
    if (!(e instanceof UseCaseError)) throw e;
    const { status, body } = failureOf(e, 'block', {
      conflict: 'admin.content.conflict.title',
      invalid: 'admin.block.error.invalid',
    });
    const conflict =
      e.code === 'conflict' ? await conflictOf(principal, itemId, revisionId, zone) : null;
    return fail(status, {
      ...body,
      fieldIssues: [],
      conflict: conflict && { who: conflict.who, when: conflict.when, changes: conflict.changes },
    });
  }
}

/**
 * One block operation after the save of the form, on the revision that save made; the screen
 * comes back at the block (`#block-<id>`), at the copy a duplicate made, or at the blocks when it
 * is gone.
 */
async function blockStep(
  saved: Committed,
  itemId: string,
  blockId: string,
  done: 'blockMoved' | 'blockRemoved' | 'blockDuplicated',
  run: (blocks: ContentDocument['blocks'], index: number) => Promise<unknown>
) {
  const { tenant, principal, revisionId, editing } = saved;
  let landing = blockId;
  // A removed block hands focus to the one that takes its place, else the one before it.
  let neighbour: string | null = null;
  const refused = await blockTry(saved, itemId, async () => {
    const { revision } = await runtime().invoker.run(useCases.getItem, principal, {
      itemId,
      revisionId,
    });
    const index = revision.document.blocks.findIndex((b) => b.id === blockId);
    if (index < 0) error(404, 'Not found');
    const blocks = revision.document.blocks;
    neighbour = (blocks[index + 1] ?? blocks[index - 1])?.id ?? null;
    const made = await run(revision.document.blocks, index);
    // A duplicate names the block it made; the screen lands there instead.
    if (typeof made === 'string') landing = made;
  });
  if (refused) return refused;
  if (done === 'blockRemoved') {
    const at = neighbour ? `block-${neighbour}` : 'blocks';
    // The revision the block was removed from names it for "Undo" (`restore`).
    redirect(
      303,
      itemPath(tenant.slug, itemId, editing, { done, undo: `${revisionId}:${blockId}` }, at)
    );
  }
  // The block lands at rest (MY-110 A): it is complete, and the screen's script puts focus back
  // on the control that moved or copied it.
  redirect(303, itemPath(tenant.slug, itemId, editing, { done }, `block-${landing}`));
}

export const actions: Actions = {
  pattern: async (event) => {
    const saved = await commit(event, { pattern: true, always: true });
    if ('failure' in saved) return saved.failure;
    redirect(303, itemPath(saved.tenant.slug, event.params.itemId, saved.editing, {}, 'blocks'));
  },
  save: async (event) => {
    const saved = await commit(event, { always: true });
    if ('failure' in saved) return saved.failure;
    const { tenant, inserted, changed } = saved;
    const open = inserted ? [inserted] : changed;
    redirect(
      303,
      itemPath(
        tenant.slug,
        event.params.itemId,
        saved.editing,
        { saved: '', ...(open.length ? { block: open.join(',') } : {}) },
        open.length ? `block-${open[0]}` : ''
      )
    );
  },
  /**
   * Input kept through an expired session (static/_admin/session-restore.js) comes back as after a
   * refused save: nothing is stored, the screen shows what was typed and says it was put back,
   * and saving stays a deliberate click. Based on an older revision, or on an address the item
   * no longer has, it is a conflict exactly like a save would get. Only for `content:write`.
   */
  recover: async (event) => {
    const { tenant, principal } = await requireTenantPrincipal(
      event.locals,
      event.url,
      event.params.tenant!
    );
    if (!can(principal, 'content:write'))
      error(403, adminUi(event.locals)('admin.error.forbidden'));
    const itemId = event.params.itemId!;
    const { item } = await latest(principal, itemId);
    const data = await event.request.formData();
    const values = valuesFromForm(data);
    const baseRevisionId = text(data, 'baseRevisionId');
    // Not a revision id: nothing to compare it with, so the item opens as it is.
    if (!UUID.test(baseRevisionId)) redirect(303, itemPath(tenant.slug, itemId, null));
    const baseSlug = data.has('baseSlug') ? text(data, 'baseSlug') : undefined;
    const stale =
      item.latestRevisionId !== baseRevisionId ||
      (baseSlug !== undefined && baseSlug !== item.slug);
    const recovered = { error: 'admin.content.recovered.body' as UiKey, recovered: true };
    if (!stale) return (await refused(tenant, principal, itemId, values, null, recovered)).data;
    const { zone } = await adminTimeZone(event.locals);
    const conflict = await conflictOf(principal, itemId, baseRevisionId, zone, baseSlug);
    return (
      await refused(
        tenant,
        principal,
        itemId,
        conflictValues(values, conflict.newest, conflict.slug),
        null,
        {
          ...recovered,
          conflict: { who: conflict.who, when: conflict.when, changes: conflict.changes },
        }
      )
    ).data;
  },
  /** "Do not add": saves the rest of the form without the pending block. */
  discard: async (event) => {
    const saved = await commit(event, { discard: true });
    if ('failure' in saved) return saved.failure;
    redirect(303, itemPath(saved.tenant.slug, event.params.itemId, saved.editing, {}, 'blocks'));
  },
  /** Shows an empty block of the chosen type at its place, after saving what was typed. */
  insert: async (event) => {
    const saved = await commit(event);
    if ('failure' in saved) return saved.failure;
    const [place = '', anchor = ''] = text(saved.data, 'insert').split(':');
    const query = {
      insert: text(saved.data, `insertType.${anchor || place}`),
      place,
      ...(anchor ? { anchor } : {}),
    };
    redirect(
      303,
      itemPath(saved.tenant.slug, event.params.itemId, saved.editing, query, 'block-new')
    );
  },
  move: async (event) => {
    const saved = await commit(event);
    if ('failure' in saved) return saved.failure;
    const [blockId = '', direction] = text(saved.data, 'move').split(':');
    return blockStep(saved, event.params.itemId, blockId, 'blockMoved', async (blocks, index) => {
      const up = direction === 'up';
      const neighbour = blocks[up ? index - 1 : index + 1];
      if (!neighbour) return;
      await runtime().invoker.run(useCases.moveBlock, saved.principal, {
        itemId: event.params.itemId,
        baseRevisionId: saved.revisionId,
        blockId,
        place: up ? { before: neighbour.id } : { after: neighbour.id },
      });
    });
  },
  remove: async (event) => {
    const saved = await commit(event);
    if ('failure' in saved) return saved.failure;
    const blockId = text(saved.data, 'remove');
    return blockStep(saved, event.params.itemId, blockId, 'blockRemoved', () =>
      runtime().invoker.run(useCases.removeBlock, saved.principal, {
        itemId: event.params.itemId,
        baseRevisionId: saved.revisionId,
        blockId,
      })
    );
  },
  /**
   * "Undo" after a removal (#66 PR 6c): the block comes back from the revision it was removed
   * from, after the nearest block before it that still stands (else before the nearest after it,
   * else at the end), with its props and a new id, saved like every block action. Rejected: a
   * confirmation before removing (one more step on every removal while the undo makes none
   * needed) and restoring the whole older revision (it would throw away what was saved since).
   */
  restore: async (event) => {
    const saved = await commit(event);
    if ('failure' in saved) return saved.failure;
    const { tenant, principal, revisionId, editing } = saved;
    const itemId = event.params.itemId!;
    const [from = '', blockId = ''] = text(saved.data, 'restore').split(':');
    let landing: string | null = null;
    const refused = await blockTry(saved, itemId, async () => {
      const rt = runtime().invoker;
      const [{ revision: old }, { revision: now }] = await Promise.all([
        rt.run(useCases.getItem, principal, { itemId, revisionId: from }),
        rt.run(useCases.getItem, principal, { itemId, revisionId }),
      ]);
      const index = old.document.blocks.findIndex((b) => b.id === blockId);
      const b = old.document.blocks[index];
      // Nothing to put back (an Undo for a block that was never there): land at the blocks.
      if (!b) return;
      const standing = new Set(now.document.blocks.map((x) => x.id));
      if (standing.has(b.id)) {
        landing = b.id;
        return;
      }
      const before = old.document.blocks
        .slice(0, index)
        .reverse()
        .find((x) => standing.has(x.id));
      const after = old.document.blocks.slice(index + 1).find((x) => standing.has(x.id));
      const { created } = await rt.run(useCases.insertBlock, principal, {
        itemId,
        baseRevisionId: revisionId,
        block: { type: b.type, version: b.version, props: structuredClone(b.props) } as BlockInput,
        place: before ? { after: before.id } : after ? { before: after.id } : { at: 'end' },
      });
      landing = created[0] ?? null;
    });
    if (refused) return refused;
    redirect(
      303,
      itemPath(
        tenant.slug,
        itemId,
        editing,
        { done: 'blockRestored' },
        landing ? `block-${landing}` : 'blocks'
      )
    );
  },
  /** A copy of the block right after it, with the same props and a new id; the screen lands on it. */
  duplicate: async (event) => {
    const saved = await commit(event);
    if ('failure' in saved) return saved.failure;
    const blockId = text(saved.data, 'duplicate');
    return blockStep(
      saved,
      event.params.itemId,
      blockId,
      'blockDuplicated',
      async (blocks, index) => {
        const b = blocks[index]!;
        const { created } = await runtime().invoker.run(useCases.insertBlock, saved.principal, {
          itemId: event.params.itemId,
          baseRevisionId: saved.revisionId,
          block: {
            type: b.type,
            version: b.version,
            props: structuredClone(b.props),
          } as BlockInput,
          place: { after: b.id },
        });
        return created[0];
      }
    );
  },
  publish: (event) =>
    publication(event, 'publish', (principal, { itemId, locale, revisionId }) =>
      runtime().invoker.run(useCases.publishItem, principal, { itemId, locale, revisionId })
    ),
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
        at: instant(at, (await adminTimeZone(event.locals)).zone),
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
  approveTranslation: async (event) => {
    const { locals, url, params } = event;
    const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'content:publish'))
      error(403, adminUi(locals)('admin.assist.error.forbidden'));
    const saved = await commit(event);
    if ('failure' in saved) return saved.failure;
    const locale = text(saved.data, 'locale');
    try {
      await runtime().invoker.run(useCases.approveTranslation, principal, {
        itemId: params.itemId,
        locale,
        baseRevisionId: saved.revisionId,
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
      itemPath(saved.tenant.slug, params.itemId, locale, { done: 'translationApproved' })
    );
  },
  /**
   * The bar's locale switch: saves what was typed, remembers the choice for the whole admin of
   * this site (`content-locale.ts`) and shows the item in the chosen locale.
   */
  switchLocale: async (event) => {
    const saved = await commit(event);
    if ('failure' in saved) return saved.failure;
    const to = text(saved.data, 'to');
    // A locale the document still has but the site no longer does is shown, not remembered.
    if (saved.tenant.locales.includes(to))
      chooseContentLocale(event.cookies, saved.tenant.slug, to);
    else {
      const { revision } = await runtime().invoker.run(useCases.getItem, saved.principal, {
        itemId: event.params.itemId,
        revisionId: saved.revisionId,
      });
      if (!revision.document.locales.includes(to))
        error(400, adminUi(event.locals)('admin.locale.unknown'));
    }
    redirect(303, itemPath(saved.tenant.slug, event.params.itemId, to));
  },
  /**
   * "Start the translation" for a locale the document lacks: after saving the rest of the form,
   * adds the locale, empty or with every value of `from` copied (`withLocale`), as one revision.
   */
  startTranslation: async (event) => {
    const saved = await commit(event);
    if ('failure' in saved) return saved.failure;
    const { tenant, principal, data, revisionId, zone } = saved;
    const itemId = event.params.itemId;
    const to = text(data, 'translateTo');
    const from = text(data, 'from') || null;
    if (!tenant.locales.includes(to)) error(400, adminUi(event.locals)('admin.locale.unknown'));
    try {
      const { revision } = await runtime().invoker.run(useCases.getItem, principal, {
        itemId,
        revisionId,
      });
      await runtime().invoker.run(useCases.updateItem, principal, {
        itemId,
        baseRevisionId: revisionId,
        document: withLocale(revision.document, to, from),
      });
    } catch (thrown) {
      const { error: e, status, body } = saveFailure(thrown);
      const conflict =
        e.code === 'conflict' ? await conflictOf(principal, itemId, revisionId, zone) : null;
      return fail(status, {
        ...body,
        fieldIssues: [],
        conflict: conflict && { who: conflict.who, when: conflict.when, changes: conflict.changes },
      });
    }
    redirect(303, itemPath(tenant.slug, itemId, to, { saved: '' }));
  },
};
