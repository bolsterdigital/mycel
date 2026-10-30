// The content ports in memory: items with their revisions and block references, and the site
// settings and brand assets that sit next to them in a tenant.

import { allBlocks } from '../../content/blocks.js';
import { documentReferences, type Revision } from '../../content/model.js';
import type { ContentRepository, ItemMatch } from '../../content/ports.js';
import type { TransactionContext } from '../../ports.js';
import { paged, type TenantStore } from './store.js';

export function memoryContent(s: TenantStore): ContentRepository {
  const insertRevision = (r: Revision) => {
    s.revisions.set(r.id, structuredClone(r));
    s.blockRefs.set(r.id, documentReferences(r.document));
  };
  return {
    // No-op, like `supporters.lock`: one process, not transactional (see memory.ts).
    lock: async (id) => structuredClone(s.items.get(id) ?? null),
    get: async (id) => structuredClone(s.items.get(id) ?? null),
    findBySlug: async (type, slug) =>
      structuredClone(
        [...s.items.values()].find((i) => i.type === type && i.slug === slug) ?? null
      ),
    list: async ({ type, slug }, after, limit) =>
      paged(
        [...s.items.values()].filter(
          (i) => (!type || i.type === type) && (!slug || i.slug === slug)
        ),
        after,
        limit
      ),
    async insert(item, first) {
      s.items.set(item.id, structuredClone(item));
      insertRevision(first);
    },
    save: async (item) => void s.items.set(item.id, structuredClone(item)),
    insertRevision: async (r) => insertRevision(r),
    async find({ blockType, ref, live, type }, after, limit) {
      const matches: (ItemMatch & { id: string })[] = [];
      for (const item of s.items.values()) {
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
