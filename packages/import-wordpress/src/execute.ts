// Execute an import plan against one tenant through the use-case registry (brief
// wordpress-import-execution, PR 2), as any editor would: `media.upload`, `content.person.create`,
// `content.section.create`, `content.item.create` and `.update`, `content.item.publish` with the
// original date. Authorisation, validation, revisions, usages and the search index behave as for a
// person in the admin; nothing writes to the database beside the use cases.
//
// Items are made in two rounds. A link from one item to another is checked at every save
// (`content.reference.item-unknown`), so an item whose blocks name another item of the export is
// first created without blocks and gets them once every item exists. Every placeholder of the plan
// is swapped for the id a use case returned; a block whose file or linked item did not make it is
// left out with a report line, so one missing image does not cost the whole article. One failed
// item does not stop the run. Rejected: creating items in dependency order (two pages that link to
// each other have none) and writing ids into the plan up front (ids are the registry's to give).

import {
  errorMessage,
  slugFromTitle,
  useCases,
  type Invoker,
  type Principal,
  type UseCaseError,
} from '@mycel/core';
import { slugOf } from './blocks.js';
import type { ImportPlan, PlannedItem, PlannedMedia, ReportLine } from './plan.js';

/** The bytes of one attachment, or why they could not be had. */
export type MediaFile = { bytes: Uint8Array; contentType: string } | { error: string };

export interface ExecuteDeps {
  invoker: Invoker;
  /** The tenant's system principal (`systemPrincipal(tenantId, 'importer')`). */
  principal: Principal;
  media(media: PlannedMedia): Promise<MediaFile>;
}

export interface ExecuteOptions {
  /** Import into a tenant that already has content (brief § Ontwerpkeuzes 7). */
  intoExisting?: boolean;
}

export interface ImportedItem {
  ref: string;
  sources: PlannedItem['sources'];
  itemId: string;
  type: string;
  slug: string;
  status: 'published' | 'draft';
}

export interface ImportResult {
  /** Placeholder id → the id the tenant gave it. */
  ids: Record<string, string>;
  items: ImportedItem[];
  /** The plan's report plus what happened during the run. */
  report: ReportLine[];
}

/** The tenant already has content and `intoExisting` was not given. */
export class TenantNotEmpty extends Error {}

const PLACEHOLDER = /00000000-0000-4000-800[1-4]-\d{12}/g;
const placeholders = (value: unknown) => [...new Set(JSON.stringify(value).match(PLACEHOLDER))];
const isItemRef = (ref: string) => ref.startsWith('00000000-0000-4000-8004-');

/** What a refusal says, for a report line: its code and first issue. */
function reason(error: unknown): string {
  const e = error as Partial<UseCaseError>;
  const issue = e.issues?.[0];
  if (e.code)
    return issue ? `${e.code} ${issue.path}: ${issue.message}` : `${e.code}: ${e.message}`;
  return errorMessage(error);
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

export async function execute(
  plan: ImportPlan,
  deps: ExecuteDeps,
  options: ExecuteOptions = {}
): Promise<ImportResult> {
  const { invoker, principal } = deps;
  const existing = await invoker.run(useCases.listItems, principal, { limit: 1 });
  if (existing.total > 0 && !options.intoExisting)
    throw new TenantNotEmpty(
      `the tenant already has ${existing.total} item(s); give --into-existing to import anyway`
    );

  const ids: Record<string, string> = {};
  const report: ReportLine[] = [...plan.report];

  for (const media of plan.media) {
    const file = await deps.media(media);
    if ('error' in file) {
      report.push({ code: 'media.failed', postId: media.sourceId, detail: file.error });
      continue;
    }
    try {
      const view = await invoker.run(useCases.uploadMedia, principal, {
        filename: media.filename,
        contentType: file.contentType,
        bytes: base64(file.bytes),
      });
      ids[media.ref] = view.id;
    } catch (error) {
      report.push({ code: 'media.failed', postId: media.sourceId, detail: reason(error) });
    }
  }

  // A slug the tenant already holds gets a number, as an editor's second "Anna" would.
  const unique = async (make: (slug: string) => Promise<string>, wanted: string) => {
    for (let n = 1; ; n++) {
      const slug = n === 1 ? wanted : `${wanted}-${n}`;
      try {
        return await make(slug);
      } catch (error) {
        if ((error as Partial<UseCaseError>).code !== 'conflict' || n >= 20) throw error;
      }
    }
  };
  for (const person of plan.people)
    try {
      ids[person.ref] = await unique(
        async (slug) =>
          (await invoker.run(useCases.createPerson, principal, { slug, name: person.name })).id,
        slugFromTitle(person.name) || slugOf(person.sourceLogin, person.sourceLogin) || 'person'
      );
    } catch (error) {
      report.push({ code: 'person.failed', detail: `${person.sourceLogin}: ${reason(error)}` });
    }
  for (const section of plan.sections)
    try {
      ids[section.ref] = await unique(
        async (slug) =>
          (
            await invoker.run(useCases.createSection, principal, {
              slug,
              title: section.title,
            })
          ).id,
        slugOf(section.sourceSlug, Object.values(section.title)[0] ?? '') || 'section'
      );
    } catch (error) {
      report.push({ code: 'section.failed', detail: `${section.sourceSlug}: ${reason(error)}` });
    }

  /**
   * The item's document with every placeholder swapped. A top-level block that names something
   * that was not made is left out; so are the header image and the featured image, and an author
   * or section that failed.
   */
  const resolve = (item: PlannedItem) => {
    const doc = structuredClone(item.document) as Record<string, unknown>;
    const at = (lines: Omit<ReportLine, 'postId' | 'title'>) =>
      report.push({ ...lines, postId: item.sources[0]!.id, title: titleOf(item) });
    const known = (ref: string) => ref in ids;
    const blocks = (doc.blocks as { type: string }[]).filter((block, i) => {
      const missing = placeholders(block).filter((r) => !known(r));
      if (missing.length)
        at({ code: 'block.reference-missing', block: block.type, position: i + 1 });
      return !missing.length;
    });
    doc.blocks = blocks;
    for (const field of ['featuredImageId', 'heroImageId'] as const)
      if (typeof doc[field] === 'string' && !known(doc[field])) {
        at({ code: 'item.image-missing', detail: field });
        delete doc[field];
        if (field === 'heroImageId') delete doc.heroAlt;
      }
    if (Array.isArray(doc.authorIds)) doc.authorIds = doc.authorIds.filter((r) => known(r));
    if (typeof doc.sectionId === 'string' && !known(doc.sectionId)) doc.sectionId = null;
    return JSON.parse(JSON.stringify(doc).replace(PLACEHOLDER, (ref) => ids[ref] ?? ref));
  };

  // Round one: every item as a draft; blocks that link to another item wait for round two.
  const made: { item: PlannedItem; itemId: string; revisionId: string; later: boolean }[] = [];
  for (const item of plan.items) {
    const later = placeholders(item.document.blocks).some(isItemRef);
    try {
      const document = resolve(item);
      const { item: created, revision } = await invoker.run(useCases.createItem, principal, {
        slug: item.slug,
        document: later ? { ...document, blocks: [] } : document,
      });
      ids[item.ref] = created.id;
      made.push({ item, itemId: created.id, revisionId: revision.id, later });
    } catch (error) {
      report.push({
        code: 'item.failed',
        postId: item.sources[0]!.id,
        title: titleOf(item),
        detail: reason(error),
      });
    }
  }

  // Round two: the blocks with links, now that every item has an id; then publish.
  const items: ImportedItem[] = [];
  for (const entry of made) {
    const { item, itemId } = entry;
    const where = { postId: item.sources[0]!.id, title: titleOf(item) };
    let revisionId = entry.revisionId;
    try {
      if (entry.later) {
        const saved = await invoker.run(useCases.updateItem, principal, {
          itemId,
          baseRevisionId: revisionId,
          document: resolve(item),
        });
        revisionId = saved.revision.id;
      }
    } catch (error) {
      report.push({ code: 'item.blocks-failed', ...where, detail: reason(error) });
    }
    let published = item.status === 'published';
    if (published)
      for (const locale of item.document.locales)
        try {
          await invoker.run(useCases.publishItem, principal, {
            itemId,
            revisionId,
            locale,
            ...(item.publishedAt && { firstPublishedAt: item.publishedAt }),
          });
        } catch (error) {
          published = false;
          report.push({ code: 'item.publish-failed', ...where, locale, detail: reason(error) });
        }
    items.push({
      ref: item.ref,
      sources: item.sources,
      itemId,
      type: item.document.type,
      slug: item.slug,
      status: published ? 'published' : 'draft',
    });
  }
  return { ids, items, report };
}

const titleOf = (item: PlannedItem) =>
  item.document.title[item.document.defaultLocale] ?? Object.values(item.document.title)[0] ?? '';
