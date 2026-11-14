// The navigation repository in memory (ADR 036, the twin of packages/db/src/navigation/repository.ts). The
// lock is the per-tenant queue of `tenantLock`; shared mode queues as well, which only makes two
// memory deletes wait for each other, never the order of a lock that matters.

import { navigationReferences } from '../../navigation/model.js';
import type { NavigationRepository, PublishedTarget } from '../../navigation/ports.js';
import type { TenantStore } from './store.js';

export function memoryNavigation(s: TenantStore, lock: () => Promise<void>): NavigationRepository {
  const nav = s.navigation;
  const live = (id: string) => (s.trashedItems.has(id) ? undefined : s.items.get(id));
  return {
    lock: async () => lock(),
    async head() {
      if (!nav.head) return null;
      return {
        latestRevisionId: nav.head.latestRevisionId,
        updatedAt: new Date(nav.head.updatedAt.getTime()),
        publication: [...nav.locales]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([locale, p]) => ({
            locale,
            revisionId: p.revisionId,
            publishedAt: new Date(p.publishedAt.getTime()),
          })),
      };
    },
    revision: async (id) => structuredClone(nav.revisions.get(id) ?? null),
    async revisions(limit) {
      return [...nav.revisions.values()]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map(({ document: _, ...summary }) => structuredClone(summary));
    },
    async insertRevision(revision) {
      nav.revisions.set(revision.id, structuredClone(revision));
      nav.head = {
        latestRevisionId: revision.id,
        updatedAt: new Date(revision.createdAt.getTime()),
      };
    },
    async publish(locale, revisionId, at) {
      nav.locales.set(locale, { revisionId, publishedAt: new Date(at.getTime()) });
    },
    unpublish: async (locale) => nav.locales.delete(locale),
    async referencingMenus(itemId) {
      const ids = new Set([
        nav.head?.latestRevisionId,
        ...[...nav.locales.values()].map((p) => p.revisionId),
      ]);
      const found = new Map<string, string>();
      for (const id of ids) {
        const revision = id ? nav.revisions.get(id) : undefined;
        if (!revision) continue;
        for (const ref of navigationReferences(revision.document))
          if (ref.itemId === itemId && !found.has(ref.menuId))
            found.set(ref.menuId, revision.document.menus.find((m) => m.id === ref.menuId)!.name);
      }
      return [...found].map(([menuId, name]) => ({ menuId, name }));
    },
    existingItems: async (ids) => new Set(ids.filter((id) => live(id))),
    async publishedTargets(ids, locale) {
      const out = new Map<string, PublishedTarget>();
      for (const id of ids) {
        const item = live(id);
        const state = item?.publication.find((p) => p.locale === locale && p.publishedRevisionId);
        const revision = state ? s.revisions.get(state.publishedRevisionId!) : undefined;
        if (!item || !revision) continue;
        const doc = revision.document;
        out.set(id, {
          itemId: id,
          type: item.type,
          slug: item.slug,
          title: doc.title[locale] ?? null,
          featuredTitle: doc.featured?.title?.[locale] ?? null,
          access: doc.access.level,
          blockIds: doc.blocks.map((b) => b.id),
        });
      }
      return out;
    },
  };
}
