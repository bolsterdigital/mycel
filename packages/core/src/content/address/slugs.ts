// Where an item's address comes from (editor trial P185-79: "Dit is de titel (/page-16e5...)").
// An item created without a title of its own gets a start slug, `<type>-<uuid>`, that only holds
// the place; until any locale has been published once, the first save that gives it a title moves
// the slug to that title, and from then on the slug stays. Core owns the start value, so HTTP, MCP
// and the admin share one rule and the pattern is not a convention two packages have to agree on.
//
// Rejected: an explicit `slug_follows_title` column. It says nothing the value does not already
// say, and costs a migration, an export rule and a second thing to keep in step with the slug.
// Rejected too: following whenever the slug equals what the previous title would give (Ghost's
// rule). That also moves a slug an editor typed in that happens to match the title, and the item
// rule is that a self-chosen address is never overwritten.
import { UseCaseError } from '../../errors.js';
import type { TransactionContext } from '../../ports.js';
import {
  type ContentDocument,
  type ContentDocumentInput,
  type ContentType,
  isReservedPageSlug,
  slugFromTitle,
} from '../model.js';
import type { ItemRecord } from '../ports.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const START = new RegExp(`^(page|article)-${UUID}$`);

/** The placeholder slug of an item that has no title of its own yet; `id` is a fresh uuid. */
export function startSlug(type: ContentType, id: string): string {
  return `${type}-${id.toLowerCase()}`;
}

/** Whether `slug` is still the placeholder `startSlug` gave an item of `type`. */
export function isStartSlug(type: ContentType, slug: string): boolean {
  return START.exec(slug)?.[1] === type;
}

/** The `detail` an API or MCP client reads: "an article", not "a article". */
export const slugTaken = (type: ContentType, slug: string) =>
  new UseCaseError(
    'conflict',
    `${type === 'article' ? 'an article' : 'a page'} with slug "${slug}" already exists`,
    [{ path: 'slug', message: 'content.slug.taken' }]
  );

const titleOf = (document: ContentDocumentInput): string =>
  document.title[document.defaultLocale] ?? Object.values(document.title)[0] ?? '';

/**
 * The slug of a new item that gave none: its title in the default locale as a slug, with `-2`,
 * `-3` and so on when that is taken or reserved. A title with nothing usable falls back to the
 * type name.
 */
export async function freeSlug(
  ctx: TransactionContext,
  document: ContentDocumentInput
): Promise<string> {
  const stem = slugFromTitle(titleOf(document)) || document.type;
  for (let n = 1; n <= 100; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const slug = `${stem.slice(0, 63 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (document.type === 'page' && isReservedPageSlug(slug)) continue;
    if (!(await ctx.content.findBySlug(document.type, slug))) return slug;
  }
  throw new UseCaseError('conflict', `no free slug for "${stem}"`);
}

/**
 * The slug `item` moves to when `next` replaces `previous`, or null when it stays. It moves only
 * while it is the start slug, no locale has ever been published (the rule of `content.slug.update`)
 * and the title in the default locale changed into one that gives a slug. A save that keeps the
 * stand-in title, or a title of only punctuation, leaves the start slug, so a later title still
 * counts.
 */
export async function slugFollowingTitle(
  ctx: TransactionContext,
  item: ItemRecord,
  previous: ContentDocument,
  next: ContentDocument
): Promise<string | null> {
  if (!isStartSlug(item.type, item.slug)) return null;
  if (item.publication.some((s) => s.firstPublishedAt)) return null;
  const title = titleOf(next);
  if (title === titleOf(previous) || !slugFromTitle(title)) return null;
  return freeSlug(ctx, next);
}
