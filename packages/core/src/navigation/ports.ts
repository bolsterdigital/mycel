// The navigation repository (ADR 036, migration 0056). One aggregate per tenant: a head naming
// the latest revision, immutable revisions, one publication pointer per locale and the content
// references of every revision. `lock` serialises writers of the aggregate; `content.item.delete`
// takes it shared before its item lock, so "navigation before content" holds on every path that
// adds or checks a reference (rule 9) and two deletes never wait for each other.

import type { ContentType } from '../content/model.js';
import type { NavigationDocument } from './model.js';

export interface NavigationRevision {
  id: string;
  document: NavigationDocument;
  /** The revision the caller read; null for the first save. */
  baseRevisionId: string | null;
  /** Saved on an older base and merged (ADR 026). */
  merged: boolean;
  /** The older revision a restore copied; null otherwise. */
  restoredFrom: string | null;
  createdAt: Date;
}

export type NavigationRevisionSummary = Omit<NavigationRevision, 'document'>;

export interface NavigationPublication {
  locale: string;
  revisionId: string;
  publishedAt: Date;
}

export interface NavigationHead {
  latestRevisionId: string;
  updatedAt: Date;
  /** Every published locale, by locale. */
  publication: NavigationPublication[];
}

/**
 * What a menu may show of a content target in one locale: only an item outside the trash with a
 * published revision in that locale, read from that revision. Never a draft, never a body.
 */
export interface PublishedTarget {
  itemId: string;
  type: ContentType;
  slug: string;
  title: string | null;
  featuredTitle: string | null;
  access: 'public' | 'members' | 'tier';
  /** The top-level block ids of the published revision, for an anchor. */
  blockIds: string[];
}

export interface NavigationRepository {
  /** Exclusive for a writer of the aggregate, shared for a delete that checks references. */
  lock(mode: 'exclusive' | 'shared'): Promise<void>;
  /** Null until the tenant's first save. */
  head(): Promise<NavigationHead | null>;
  /** A revision of this tenant; another tenant's is null. */
  revision(id: string): Promise<NavigationRevision | null>;
  /** The newest revisions first, at most `limit`. */
  revisions(limit: number): Promise<NavigationRevisionSummary[]>;
  /** Inserts the revision with its references and makes it the latest, under the lock. */
  insertRevision(revision: NavigationRevision): Promise<void>;
  publish(locale: string, revisionId: string, at: Date): Promise<void>;
  /** False when the locale was not published. */
  unpublish(locale: string): Promise<boolean>;
  /**
   * The menus of the latest or a published revision that target this item, by id with their name
   * in that revision (rule 9: older revisions do not block).
   */
  referencingMenus(itemId: string): Promise<{ menuId: string; name: string }[]>;
  /** Of these ids, the pages and articles that exist outside the trash. */
  existingItems(itemIds: readonly string[]): Promise<Set<string>>;
  /** One batched read of the published targets in a locale, by item id; others are absent. */
  publishedTargets(
    itemIds: readonly string[],
    locale: string
  ): Promise<Map<string, PublishedTarget>>;
}

declare module '../ports.js' {
  interface TransactionContext {
    navigation: NavigationRepository;
  }
}
