// Repositories of the content module. `lock` is the item lock every write and the scheduled
// publish take first (SELECT ... FOR UPDATE in Postgres): saves, publication changes and the job
// serialise per item, so "two saves on one base, exactly one wins" and "an old job cannot
// publish after a reschedule" follow from the lock order, not from timing.

import type { PersonGroup } from './people/model.js';
import type { AccessTier } from './access/model.js';
import type { SearchReader } from './published/search.js';

import type { BulkPlan, BulkPhase, BulkResult } from './bulk/model.js';
import type { PresenceEntry } from './presence/model.js';
import type { BlockType, ReferenceType } from './blocks.js';
import type { LocaleState } from './lifecycle.js';
import type { ItemFilter, ItemOrder } from './listing.js';
import type {
  Author,
  ContentDocument,
  ContentProfile,
  ContentType,
  Pattern,
  Revision,
  RevisionSummary,
  Section,
} from './model.js';

export interface ItemRecord {
  id: string;
  type: ContentType;
  /** A page's type profile, fixed at creation; null on an ordinary page and every article. */
  profile: ContentProfile | null;
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

/**
 * One published locale of an item, as the public list (`content.published.list`) reads it:
 * the publication pointer and the few fields a sitemap or feed decides on, never a document.
 * `noindex`, `sectionId` and `access` are those of the published revision, not of a later draft.
 */
export interface PublishedEntry {
  itemId: string;
  type: ContentType;
  slug: string;
  locale: string;
  /** Every published locale of the item, in the item's locale order. */
  locales: string[];
  revisionId: string;
  publishedAt: Date;
  /** When the published revision was saved. */
  updatedAt: Date;
  noindex: boolean;
  /** The published revision's canonical URL when it points elsewhere; null for its own address. */
  canonical: string | null;
  sectionId: string | null;
  access: 'public' | 'members' | 'tier';
}

/**
 * What an overview block asks for: published locales in `locale` whose published revision
 * is public. `ids` narrows to those items (the pins), `exclude` leaves items out (the pins again,
 * under the list). Section and tags apply to articles; every tag must be on the article. `events`
 * narrows to pages with the `event` profile and a start, and orders by that start instead.
 */
export interface PublishedCardFilter {
  locale: string;
  type?: ContentType | undefined;
  sectionId?: string | undefined;
  /** Articles whose published revision names this person among its authors. */
  authorId?: string | undefined;
  /** Canonical tags (`canonicalTag`), all required. */
  tags?: readonly string[] | undefined;
  ids?: readonly string[] | undefined;
  exclude?: readonly string[] | undefined;
  /** By the first publication in this locale, then item id ascending. */
  order: 'newest' | 'oldest';
  /**
   * Events on the wall clock `now` (`YYYY-MM-DDTHH:mm`, the site's zone), compared as text with
   * `endsAt ?? startsAt` of the published revision: upcoming is at or after `now`, by start
   * ascending; past is before it, by start descending; item id ascending breaks a tie. Replaces
   * `order`.
   */
  events?: { when: 'upcoming' | 'past'; now: string } | undefined;
  /**
   * Also restricted items (ADR 016). Off by default: a row carries the whole published document,
   * so a caller that asks for these projects each one (`cardDocument`) before it shows anything.
   */
  restricted?: boolean | undefined;
}

/** One published locale with its published revision's document, for a card. */
export interface PublishedCardRow {
  itemId: string;
  type: ContentType;
  slug: string;
  revisionId: string;
  /** When this locale was first published: an edit republished later does not move it. */
  firstPublishedAt: Date;
  document: ContentDocument;
}

/** Where a page of the published list starts: after this row of its order. */
export interface PublishedPosition {
  publishedAt: Date;
  itemId: string;
  locale: string;
}

/**
 * One hit of the site search (`content.published.find`): a published locale whose indexable
 * revision matches for the asking reader, with what the order needs. No text: the use case reads
 * the revision.
 */
export interface PublishedHit {
  itemId: string;
  type: ContentType;
  slug: string;
  revisionId: string;
  publishedAt: Date;
  /** The title alone carries every token, which ranks first. */
  inTitle: boolean;
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
/** An old slug of an item that forwards to it (migration 0062). */
export interface ItemRedirect {
  slug: string;
  createdAt: Date;
}

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
   * The item an old slug of `type` forwards to (0062), or null. The item may be in the trash; the
   * caller reads it with `get`, which leaves a trashed one out.
   */
  redirectOf(type: ContentType, slug: string): Promise<string | null>;
  /** The old slugs of an item, oldest first. */
  redirects(itemId: string): Promise<ItemRedirect[]>;
  /** Keeps `slug` as an old address of the item, of the item's type. */
  addRedirect(itemId: string, type: ContentType, slug: string, at: Date): Promise<void>;
  /** Removes an old address of `type`; false when there was none. */
  dropRedirect(type: ContentType, slug: string): Promise<boolean>;
  /**
   * Inserts the revision and its `content_block_refs` rows, derived from the document here so no
   * caller can forget them (`documentReferences`).
   */
  insertRevision(revision: Revision): Promise<void>;
  /** Items whose latest (or, with `live`, published) revision matches; newest first. */
  find(filter: FindFilter, after: string | null, limit: number): Promise<Paged<ItemMatch>>;
  /**
   * One row per published locale of an item outside the trash, newest publication first, then
   * by item id and locale (code-point order) ascending; `after` is the last row of the previous
   * page. The order is core's (`comparePublished`); timestamps compare at millisecond precision.
   */
  listPublished(
    filter: { type?: ContentType | undefined; sectionId?: string | undefined },
    after: PublishedPosition | null,
    limit: number
  ): Promise<PublishedEntry[]>;
  /**
   * The rows of an overview (`PublishedCardFilter`) outside the trash, in its order, from row
   * `offset`: one query per call, so a grid of 24 is not 24 reads. A document that no longer
   * parses is left out, as in a list.
   */
  publishedCards(
    filter: PublishedCardFilter,
    offset: number,
    limit: number
  ): Promise<PublishedCardRow[]>;
  /**
   * The published locales in `locale`, outside the trash, whose published revision is indexable
   * and matches every token as a prefix for `reader` (core's `searchEntry` and `matchesSearch`:
   * the whole text where `searchOpens`, else the teaser), in the order of `compareHits`, from row
   * `offset`. Only the revision a publication pointer names now can match: an older revision, a
   * later draft and an unpublished locale never do.
   */
  searchPublished(
    query: { tokens: readonly string[]; locale: string; reader: SearchReader | null },
    offset: number,
    limit: number
  ): Promise<PublishedHit[]>;
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

/** Patterns are the one entity an editor deletes outright: documents keep their own copies. */
export interface PatternRepository extends EntityRepository<Pattern> {
  /** Removes the row; false when there was none (or it belongs to another tenant). */
  remove(id: string): Promise<boolean>;
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

/**
 * The people register lists one kind at a time when asked, so a page of authors is a full page
 * of people. Rejected: filtering a page after the read, which leaves an author picker short of
 * people whenever organisations are among the newest entries.
 */
export interface PersonRepository extends SluggedRepository<Author> {
  list(after: string | null, limit: number, kind?: Author['kind']): Promise<Paged<Author>>;
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

export interface PersonGroupRepository {
  get(id: string): Promise<PersonGroup | null>;
  list(offset: number, limit: number): Promise<PersonGroup[]>;
  insert(group: PersonGroup): Promise<void>;
  update(group: PersonGroup, baseUpdatedAt: string): Promise<boolean>;
}
/**
 * The person register of ADR 034 (migration 0050): append-only, one row per erased person id,
 * never an address. `register` takes the tenant's person-erasure lock exclusively and `guard`
 * takes it shared, so a write that stores a credit and a registration serialise: a write that
 * guarded before the registration commits first, one that guards after it reads the new row
 * (ADR 034 rule 4). Applying the register is `ctx.erasures.apply()`, the same per-tenant run as
 * for supporters.
 */
export interface PersonErasureRepository {
  /** Appends the canonical ids that are not yet registered; returns the ones it appended. */
  register(personIds: readonly string[]): Promise<string[]>;
  /** Shared lock against `register`, held until commit; take it before reading the register. */
  guard(): Promise<void>;
  /** Which of `ids` are registered, in any case; returns them canonical (`canonicalPersonId`). */
  registered(ids: Iterable<string>): Promise<Set<string>>;
  get(personId: string): Promise<{ registeredAt: Date } | null>;
}
declare module '../ports.js' {
  interface TransactionContext {
    personErasures: PersonErasureRepository;
    personGroups: PersonGroupRepository;
    content: ContentRepository;
    bulkPlans: BulkPlanRepository;
    presence: PresenceRepository;
    authors: PersonRepository;
    sections: SluggedRepository<Section>;
    /**
     * The tenant's access tiers (ADR 016 rule 2). There is no delete: an article and a grant
     * point at a tier by id, and a tier that could vanish would leave published access to guess at.
     */
    accessTiers: SluggedRepository<AccessTier>;
    patterns: PatternRepository;
  }
}
