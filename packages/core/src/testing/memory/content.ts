// The content ports in memory: items with their revisions and block references, and the site
// settings and brand assets that sit next to them in a tenant.

import { allBlocks } from '../../content/blocks.js';
import { documentReferences, type Revision } from '../../content/model.js';
import { compareItems, matchesItemDocument, matchesItemFilter } from '../../content/listing.js';
import { comparePublished } from '../../content/published/list.js';
import type {
  BulkPlanRepository,
  ContentRepository,
  ItemMatch,
  ItemRecord,
  PresenceRepository,
  PublishedEntry,
} from '../../content/ports.js';
import { PRESENCE_READ_LIMIT } from '../../content/presence/model.js';
import type { TransactionContext } from '../../ports.js';
import { paged, type TenantStore } from './store.js';

/** The trash half of the content port, split off so `memoryContent` stays readable. */
function memoryTrash(
  s: TenantStore,
  kept: () => ItemRecord[]
): Pick<ContentRepository, 'lockTrashed' | 'trash' | 'restore' | 'trashed'> {
  return {
    lockTrashed: async (id) =>
      structuredClone(s.trashedItems.has(id) ? (s.items.get(id) ?? null) : null),
    async trash(itemId, at) {
      s.items.set(itemId, { ...s.items.get(itemId)!, updatedAt: at });
      s.trashedItems.set(itemId, at);
    },
    async restore(itemId, slug, at) {
      const item = s.items.get(itemId)!;
      if (kept().some((i) => i.type === item.type && i.slug === slug)) return false;
      s.items.set(itemId, { ...item, slug, updatedAt: at });
      s.trashedItems.delete(itemId);
      return true;
    },
    async trashed(offset, limit) {
      const all = [...s.trashedItems.entries()].sort(
        ([a, x], [b, y]) => y.getTime() - x.getTime() || (a < b ? 1 : -1)
      );
      return {
        rows: all.slice(offset, offset + limit).map(([id, deletedAt]) => ({
          item: structuredClone(s.items.get(id)!),
          deletedAt,
        })),
        total: all.length,
      };
    },
  };
}

/** The public list, by core's order (`comparePublished`), over the publication pointers. */
function memoryPublished(
  s: TenantStore,
  kept: () => ItemRecord[]
): Pick<ContentRepository, 'listPublished'> {
  return {
    async listPublished({ type, sectionId }, after, limit) {
      const rows: PublishedEntry[] = kept().flatMap((item) => {
        if (type && item.type !== type) return [];
        const live = item.publication.filter((p) => p.publishedRevisionId);
        return live.flatMap((p) => {
          const revision = s.revisions.get(p.publishedRevisionId!)!;
          const doc = revision.document;
          const section = doc.type === 'article' ? (doc.sectionId ?? null) : null;
          if (sectionId && section !== sectionId) return [];
          return [
            {
              itemId: item.id,
              type: item.type,
              slug: item.slug,
              locale: p.locale,
              locales: live.map((l) => l.locale),
              revisionId: revision.id,
              publishedAt: new Date(p.publishedAt!.getTime()),
              updatedAt: new Date(revision.createdAt),
              noindex: doc.seo.noindex,
              sectionId: section,
              access: doc.access.level,
            },
          ];
        });
      });
      return rows
        .sort(comparePublished)
        .filter((r) => after === null || comparePublished(after, r) < 0)
        .slice(0, limit);
    },
  };
}

export function memoryContent(s: TenantStore): ContentRepository {
  const insertRevision = (r: Revision) => {
    s.revisions.set(r.id, structuredClone(r));
    s.blockRefs.set(r.id, documentReferences(r.document));
  };
  // Items outside the trash, as the Postgres adapter's `items()` (ADR 030 rule 2).
  const kept = () => [...s.items.values()].filter((i) => !s.trashedItems.has(i.id));
  const liveItem = (id: string) => (s.trashedItems.has(id) ? undefined : s.items.get(id));
  return {
    // No-op, like `supporters.lock`: one process, not transactional (see memory.ts).
    lock: async (id) => structuredClone(liveItem(id) ?? null),
    get: async (id) => structuredClone(liveItem(id) ?? null),
    findBySlug: async (type, slug) =>
      structuredClone(kept().find((i) => i.type === type && i.slug === slug) ?? null),
    ...memoryTrash(s, kept),
    ...memoryPublished(s, kept),
    async list(filter, { order, after, offset, limit }) {
      const compare = compareItems(order, filter.locale);
      const matching = kept().filter((i) => {
        const latest = s.revisions.get(i.latestRevisionId);
        return (
          matchesItemFilter(i, filter) && latest && matchesItemDocument(latest.document, filter)
        );
      });
      // Found by id alone: the item a page continues after may no longer match the filter. In
      // the `created` order the id is the whole position, so it need not name an item.
      const pivot =
        after === null
          ? null
          : order.by === 'created'
            ? ({ id: after } as ItemRecord)
            : (s.items.get(after) ?? undefined);
      const rows =
        pivot === undefined
          ? []
          : matching.sort(compare).filter((r) => pivot === null || compare(r, pivot) > 0);
      const page = rows.slice(offset, offset + limit).map((r) => structuredClone(r));
      return {
        rows: page,
        next: rows.length > offset + limit ? (page.at(-1)?.id ?? null) : null,
        total: matching.length,
      };
    },
    async latestDocuments(itemIds) {
      const found = new Map();
      for (const id of itemIds) {
        const item = liveItem(id);
        const latest = item && s.revisions.get(item.latestRevisionId);
        if (latest) found.set(id, structuredClone(latest.document));
      }
      return found;
    },
    async offeredForReview(limit) {
      return kept()
        .flatMap((i) =>
          i.publication.flatMap((p) =>
            p.review
              ? [
                  {
                    itemId: i.id,
                    locale: p.locale,
                    title: i.title[p.locale] ?? i.title[i.defaultLocale] ?? null,
                    since: new Date(p.review.since),
                  },
                ]
              : []
          )
        )
        .sort((a, b) => b.since.getTime() - a.since.getTime())
        .slice(0, limit);
    },
    async insert(item, first) {
      const taken = kept().some((i) => i.type === item.type && i.slug === item.slug);
      if (taken) return false;
      s.items.set(item.id, structuredClone(item));
      insertRevision(first);
      return true;
    },
    save: async (item) => void s.items.set(item.id, structuredClone(item)),
    async setSlug(itemId, slug, at) {
      const item = s.items.get(itemId)!;
      const holder = kept().find((i) => i.type === item.type && i.slug === slug);
      if (holder && holder.id !== itemId) return false;
      s.items.set(itemId, { ...item, slug, updatedAt: at });
      return true;
    },
    insertRevision: async (r) => insertRevision(r),
    async find({ blockType, ref, live, type }, after, limit) {
      const matches: (ItemMatch & { id: string })[] = [];
      for (const item of kept()) {
        if (type && item.type !== type) continue;
        const revisionIds = live
          ? new Set(item.publication.flatMap((p) => p.publishedRevisionId ?? []))
          : new Set([item.latestRevisionId]);
        let found = false;
        const blockIds = new Set<string>();
        for (const id of revisionIds) {
          const typed = blockType
            ? allBlocks(s.revisions.get(id)!.document.blocks).filter((b) => b.type === blockType)
            : [];
          const refs = ref
            ? (s.blockRefs.get(id) ?? []).filter((r) => r.type === ref.type && r.refId === ref.id)
            : [];
          if ((blockType && !typed.length) || (ref && !refs.length)) continue;
          found = true;
          for (const b of typed) blockIds.add(b.id);
          for (const r of refs) if (r.blockId) blockIds.add(r.blockId);
        }
        if (found) matches.push({ id: item.id, item, blockIds: [...blockIds] });
      }
      const page = paged(matches, after, limit);
      return { ...page, rows: page.rows.map(({ item, blockIds }) => ({ item, blockIds })) };
    },
    async liveReferences(ref) {
      return [...s.items.values()].filter((item) =>
        item.publication.some((p) =>
          (s.blockRefs.get(p.publishedRevisionId ?? '') ?? []).some(
            (r) => r.type === ref.type && r.refId === ref.id
          )
        )
      ).length;
    },
    async revision(itemId, revisionId) {
      const r = s.revisions.get(revisionId);
      return r && r.itemId === itemId ? structuredClone(r) : null;
    },
    async revisions(itemId, after, limit) {
      const page = paged(
        [...s.revisions.values()].filter((r) => r.itemId === itemId),
        after,
        limit
      );
      return { ...page, rows: page.rows.map(({ document: _d, ...summary }) => summary) };
    },
  };
}

/** Theme, chrome, general settings and brand assets, each a versioned value with a compare-and-set write. */
export function memorySite(
  s: TenantStore
): Pick<TransactionContext, 'siteSettings' | 'brandAssets' | 'brandProcessor'> {
  return {
    siteSettings: {
      theme: async () => structuredClone(s.siteTheme),
      chrome: async () => structuredClone(s.siteChrome),
      updateTheme: async (baseVersion, value) => {
        if (s.siteTheme.version !== baseVersion) return null;
        s.siteTheme = { version: baseVersion + 1, value: structuredClone(value) };
        return s.siteTheme.version;
      },
      updateChrome: async (baseVersion, value) => {
        if (s.siteChrome.version !== baseVersion) return null;
        s.siteChrome = { version: baseVersion + 1, value: structuredClone(value) };
        return s.siteChrome.version;
      },
      general: async () => structuredClone(s.siteGeneral),
      updateGeneral: async (baseVersion, value) => {
        if (s.siteGeneral.version !== baseVersion) return null;
        s.siteGeneral = { version: baseVersion + 1, value: structuredClone(value) };
        return s.siteGeneral.version;
      },
      images: async () => structuredClone(s.siteImages),
      updateImages: async (baseVersion, value) => {
        if (s.siteImages.version !== baseVersion) return null;
        s.siteImages = { version: baseVersion + 1, value: structuredClone(value) };
        return s.siteImages.version;
      },
      retention: async () => structuredClone(s.siteRetention),
      updateRetention: async (baseVersion, value) => {
        if (s.siteRetention.version !== baseVersion) return null;
        s.siteRetention = { version: baseVersion + 1, value: structuredClone(value) };
        return s.siteRetention.version;
      },
    },
    brandAssets: {
      get: async (kind) => structuredClone(kind === 'logo' ? s.brandLogo : s.brandFont),
      replace: async (kind, baseVersion, asset) => {
        const state = kind === 'logo' ? s.brandLogo : s.brandFont;
        if (state.version !== baseVersion) return null;
        const next = { version: baseVersion + 1, asset: structuredClone(asset) };
        if (kind === 'logo') s.brandLogo = next;
        else s.brandFont = next;
        return next.version;
      },
    },
    brandProcessor: {
      logo: async (bytes) => ({
        bytes,
        contentType: 'image/webp' as const,
        width: 1,
        height: 1,
        licence: null,
      }),
      font: async () => {},
    },
  };
}

/** Immutable plans and transaction-locked receipts, separate from the composition. */
export function memoryBulkPlans(s: TenantStore, lock: () => Promise<void>): BulkPlanRepository {
  return {
    async lock(id) {
      await lock();
      return s.bulkPlans.has(id);
    },
    undoRequested: async (id) => s.bulkUndo.has(id),
    requestUndo: async (id) => {
      s.bulkUndo.add(id);
    },
    result: async (id, ordinal, phase) =>
      structuredClone(s.bulkResults.get(`${id}:${ordinal}:${phase}`) ?? null),
    record: async (id, ordinal, phase, result) => {
      s.bulkResults.set(`${id}:${ordinal}:${phase}`, structuredClone(result));
    },
    async report(id) {
      const results = [];
      for (let ordinal = 0; ordinal < (s.bulkPlans.get(id)?.items.length ?? 0); ordinal++)
        for (const phase of ['apply', 'undo'] as const) {
          const result = s.bulkResults.get(`${id}:${ordinal}:${phase}`);
          if (result) results.push({ ordinal, phase, result: structuredClone(result) });
        }
      return { undoRequested: s.bulkUndo.has(id), results };
    },
    async insert(plan) {
      if (s.bulkPlans.has(plan.id)) throw new Error('duplicate bulk plan');
      s.bulkPlans.set(plan.id, structuredClone(plan));
    },
    async get(id) {
      return structuredClone(s.bulkPlans.get(id) ?? null);
    },
  };
}

export function memoryPresence(s: TenantStore): PresenceRepository {
  return {
    async beat(entry) {
      s.presence.set(`${entry.itemId}/${JSON.stringify(entry.actor)}/${entry.sessionId}`, entry);
    },
    async active(itemId, since) {
      return [...s.presence.values()]
        .filter((e) => e.itemId === itemId && e.lastSeenAt > since)
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
        .slice(0, PRESENCE_READ_LIMIT);
    },
  };
}
