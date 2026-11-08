// Repositories of the content module. `lock` is the item lock every write and the scheduled
// publish take first (SELECT ... FOR UPDATE in Postgres): saves, publication changes and the job
// serialise per item, so "two saves on one base, exactly one wins" and "an old job cannot
// publish after a reschedule" follow from the lock order, not from timing.

import type { BulkPlan, BulkPhase, BulkResult } from './bulk/model.js';
import type { PresenceEntry } from './presence/model.js';
import type { BlockType, ReferenceType } from './blocks.js';
import type { LocaleState } from './lifecycle.js';
import type { ItemFilter, ItemOrder } from './listing.js';
import type {
  Author,
  ContentDocument,
  ContentType,
  Pattern,
  Revision,
  RevisionSummary,
  Section,
} from './model.js';

export interface ItemRecord {
  id: string;
  type: ContentType;
  slug: string;
  /** The latest revision's title, kept on the item so lists need no revision reads. */
  title: Record<string, string>;
  defaultLocale: string;
  locales: string[];
  latestRevisionId: string;
  createdAt: Date;
  updatedAt: Date;
  publication: LocaleState[];
}

export interface Paged<T> {
  rows: T[];
  /** Pass as `after` for the next page; null on the last page. */
  next: string | null;
}

/** Where a page of a list starts: after one item of the order, then past `offset` rows. */
export interface ItemPosition {
  order: ItemOrder;
  /** An item id: the page holds what follows it in `order`, wherever that item stands now. */
  after: string | null;
  offset: number;
  limit: number;
}

/** A page of items with the number of items the filter matches in all. */
export interface ItemPage extends Paged<ItemRecord> {
  total: number;
}

/** What `content.item.find` looks for; at least one of `blockType` and `ref` is set. */
export interface FindFilter {
  blockType?: BlockType | undefined;
  ref?: { type: ReferenceType; id: string } | undefined;
  /** Search the revisions a locale publishes instead of the latest revision. */
  live: boolean;
  type?: ContentType | undefined;
}

/** A found item with the blocks that matched: of the block type, or carrying the reference. */
export interface ItemMatch {
  item: ItemRecord;
  blockIds: string[];
}

/** A locale offered for publication, as the attention list names it. */
export interface OfferedLocale {
  itemId: string;
  locale: string;
  /** The item's title in that locale, else in its default locale; null when it has neither. */
  title: string | null;
  since: Date;
}

/** An item in the trash, with the moment it went there (ADR 030). */
export interface TrashedItem {
  item: ItemRecord;
  deletedAt: Date;
}

/**
 * Every read and lock below leaves an item in the trash out, so no use case can act on one by
 * accident (ADR 030 rule 2); only `lockTrashed` and `trashed` see them.
 */
export interface ContentRepository {
  /** The item with its publication rows, locked for the rest of the transaction. */
  lock(itemId: string): Promise<ItemRecord | null>;
  get(itemId: string): Promise<ItemRecord | null>;
  findBySlug(type: ContentType, slug: string): Promise<ItemRecord | null>;
  /**
   * The items `filter` matches, in `position.order`. The rules are core's (`matchesItemFilter`,
   * `compareItems`); an `after` that names no item of this tenant gives an empty page, except in
   * the `created` order, where any id is a position.
   */
  list(filter: ItemFilter, position: ItemPosition): Promise<ItemPage>;
  /**
   * A new item with its first revision (inserted in the same transaction, refs included). False:
   * the slug is taken, by a request that passed the same check first. As with `setSlug`, the
   * transaction may be unusable after false: the caller refuses, it does not go on.
   */
  insert(item: ItemRecord, first: Revision): Promise<boolean>;
  /** Item columns and the complete set of publication rows; rows not in the list are removed. */
  save(item: ItemRecord): Promise<void>;
  /**
   * Moves the item to `slug` and stamps `updatedAt`; false when another item of its type holds
   * the slug. The unique key decides, so two renames racing to one free slug end in one true and
   * one false. After false the transaction may be unusable: the caller refuses, it does not go on.
   */
  setSlug(itemId: string, slug: string, at: Date): Promise<boolean>;
  /**
   * Inserts the revision and its `content_block_refs` rows, derived from the document here so no
   * caller can forget them (`documentReferences`).
   */
  insertRevision(revision: Revision): Promise<void>;
  /** Items whose latest (or, with `live`, published) revision matches; newest first. */
  find(filter: FindFilter, after: string | null, limit: number): Promise<Paged<ItemMatch>>;
  /** The item if it is in the trash, locked for the rest of the transaction; else null. */
  lockTrashed(itemId: string): Promise<ItemRecord | null>;
  /** Moves a locked item to the trash and stamps `updatedAt`; its address becomes free. */
  trash(itemId: string, at: Date): Promise<void>;
  /**
   * Brings a locked item back at `slug` and stamps `updatedAt`; false when another item holds the
   * slug, with the same caveat as `setSlug`: the caller refuses, it does not go on.
   */
  restore(itemId: string, slug: string, at: Date): Promise<boolean>;
  /** The trash, most recently deleted first, with its size. */
  trashed(offset: number, limit: number): Promise<{ rows: TrashedItem[]; total: number }>;
  /** How many items publish a revision, in any locale, that uses `ref` (ADR 004 rule 6). */
  liveReferences(ref: { type: ReferenceType; id: string }): Promise<number>;
  /**
   * The document of each item's latest revision, by item id, for what a list says about a row. An
   * unknown id has no entry, and neither has a document that no longer validates: a list fails on
   * no single row. Rendering and editing read `revision`, which does fail.
   */
  latestDocuments(itemIds: readonly string[]): Promise<Map<string, ContentDocument>>;
  /** The locales offered for publication, newest offer first, at most `limit`. */
  offeredForReview(limit: number): Promise<OfferedLocale[]>;
  /** A revision of this item; another item's revision is null. */
  revision(itemId: string, revisionId: string): Promise<Revision | null>;
  revisions(itemId: string, after: string | null, limit: number): Promise<Paged<RevisionSummary>>;
}

export interface EntityRepository<T extends { id: string }> {
  get(id: string): Promise<T | null>;
  list(after: string | null, limit: number): Promise<Paged<T>>;
  insert(entity: T): Promise<void>;
  update(entity: T): Promise<void>;
}

export interface SluggedRepository<
  T extends { id: string; slug: string; updatedAt: string },
> extends Omit<EntityRepository<T>, 'insert' | 'update'> {
  /** False: the slug is taken; the caller refuses, as with `ContentRepository.insert`. */
  insert(entity: T): Promise<boolean>;
  /**
   * Writes `entity` only while the stored row still has `baseUpdatedAt` (compare-and-set, ADR
   * 027); false when it changed in between or is gone. Atomic against a concurrent update.
   */
  update(entity: T, baseUpdatedAt: string): Promise<boolean>;
  findBySlug(slug: string): Promise<T | null>;
}

export interface BulkPlanRepository {
  insert(plan: BulkPlan): Promise<void>;
  get(id: string): Promise<BulkPlan | null>;
  /** Run lock held until commit, before content/media locks. Also serialises the undo barrier. */
  lock(id: string): Promise<boolean>;
  undoRequested(id: string): Promise<boolean>;
  requestUndo(id: string): Promise<void>;
  result(id: string, ordinal: number, phase: BulkPhase): Promise<BulkResult | null>;
  record(id: string, ordinal: number, phase: BulkPhase, result: BulkResult): Promise<void>;
  /** One consistent read of the barrier and all receipts, never mixed transaction snapshots. */
  report(id: string): Promise<{
    undoRequested: boolean;
    results: { ordinal: number; phase: BulkPhase; result: BulkResult }[];
  }>;
}

/**
 * Who has an item open (ADR 029). Written on every beat of every open tab, without any of the
 * content locks, and its rows are not content: no revision, no export, no audit.
 */
export interface PresenceRepository {
  /** Reports one tab; the same actor and session on the same item replaces its earlier report. */
  beat(entry: PresenceEntry): Promise<void>;
  /** The tabs on this item last seen after `since`, newest first, at most PRESENCE_READ_LIMIT. */
  active(itemId: string, since: Date): Promise<PresenceEntry[]>;
}

declare module '../ports.js' {
  interface TransactionContext {
    content: ContentRepository;
    bulkPlans: BulkPlanRepository;
    presence: PresenceRepository;
    authors: SluggedRepository<Author>;
    sections: SluggedRepository<Section>;
    patterns: EntityRepository<Pattern>;
  }
}
