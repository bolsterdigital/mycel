// Repositories of the content module. `lock` is the item lock every write and the scheduled
// publish take first (SELECT ... FOR UPDATE in Postgres): saves, publication changes and the job
// serialise per item, so "two saves on one base, exactly one wins" and "an old job cannot
// publish after a reschedule" follow from the lock order, not from timing.

import type { BlockType, ReferenceType } from './blocks.js';
import type { LocaleState } from './lifecycle.js';
import type { Author, ContentType, Pattern, Revision, RevisionSummary, Section } from './model.js';

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

export interface ContentRepository {
  /** The item with its publication rows, locked for the rest of the transaction. */
  lock(itemId: string): Promise<ItemRecord | null>;
  get(itemId: string): Promise<ItemRecord | null>;
  findBySlug(type: ContentType, slug: string): Promise<ItemRecord | null>;
  /** Newest first; `after` is the last id of the previous page. */
  list(
    filter: { type?: ContentType | undefined; slug?: string | undefined },
    after: string | null,
    limit: number
  ): Promise<Paged<ItemRecord>>;
  /** A new item with its first revision (inserted in the same transaction, refs included). */
  insert(item: ItemRecord, first: Revision): Promise<void>;
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
  /** How many items publish a revision, in any locale, that uses `ref` (ADR 004 rule 6). */
  liveReferences(ref: { type: ReferenceType; id: string }): Promise<number>;
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
  T extends { id: string; slug: string },
> extends EntityRepository<T> {
  findBySlug(slug: string): Promise<T | null>;
}

declare module '../ports.js' {
  interface TransactionContext {
    content: ContentRepository;
    authors: SluggedRepository<Author>;
    sections: SluggedRepository<Section>;
    patterns: EntityRepository<Pattern>;
  }
}
