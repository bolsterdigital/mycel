// The pattern choice of a new item: `content/new` and the empty column of `content/[itemId]`
// offer the same list and fill a document the same way. An article first gets the standard long
// read of ADR 012 rule 8, core's factory built for the item's locales, so every site has it without
// a saved pattern; then the site's own patterns, grouped by the type they are meant for.
//
// The photo story, the other standard of rule 8, is offered by `content/new` only: core's factory
// needs the tenant's photos with their alt text, which that form asks for before it creates the
// item. The empty column has no such step, so it does not offer one it could only refuse.
//
// The standard values are not pattern ids and never reach `content.pattern.get`. Rejected:
// saving them as patterns when a tenant is created, which existing tenants would miss and an editor
// could delete; and a second long-read path in the editor that could drift from `content/new`.
import {
  MAX_PAGE_SIZE,
  UseCaseError,
  longReadPattern,
  photoStoryPattern,
  pickAny,
  useCases,
  type BlockInput,
  type ContentType,
  type Pattern,
  type Principal,
  type StoryPhoto,
} from '@mycel/core';
import { runtime } from '#lib/server/runtime.js';

/** The value of the standard long-read choice. */
export const LONG_READ = 'standard:long-read';
/** The value of the standard photo-story choice. */
export const PHOTO_STORY = 'standard:photo-story';

export interface PatternChoices {
  /** The long read's value, offered first under "Standard"; only for an article. */
  longRead: string | null;
  /** The photo story's value, after the long read; only for an article in `content/new`. */
  photoStory: string | null;
  /** The site's own patterns; `type` is the group each stands in. */
  own: { id: string; type: ContentType; name: string }[];
}

/**
 * What a new item of `type` can start from. `only` keeps the patterns meant for that type (the empty
 * column, which knows its item); without it every pattern is offered in the group of its type
 * (`content/new`). Names in the first of `locales` that has one, else in any.
 */
export function choicesOf(
  patterns: readonly Pick<Pattern, 'id' | 'name' | 'intendedType'>[],
  type: ContentType,
  locales: readonly string[],
  only = false
): PatternChoices {
  return {
    longRead: type === 'article' ? LONG_READ : null,
    photoStory: type === 'article' && !only ? PHOTO_STORY : null,
    own: patterns
      .filter((p) => !only || p.intendedType === type)
      .map((p) => ({ id: p.id, type: p.intendedType, name: pickAny(p.name, ...locales) ?? p.id })),
  };
}

/** The site's patterns as `choicesOf` offers them. */
export async function patternChoices(
  principal: Principal,
  type: ContentType,
  locales: readonly string[],
  only = false
): Promise<PatternChoices> {
  const { patterns } = await runtime().invoker.run(useCases.listPatterns, principal, {
    limit: MAX_PAGE_SIZE,
  });
  return choicesOf(patterns, type, locales, only);
}

/**
 * The standard pattern `choice` names, for an item of `type` in `locales`; null for any other.
 * The photo story is built from `photos` and is null without one: the caller asks for them.
 */
export function standardBlocks(
  choice: string,
  type: ContentType,
  locales: readonly string[],
  photos: readonly StoryPhoto[] = []
): BlockInput[] | null {
  // Without a locale core refuses the document anyway; a page has no standard pattern.
  if (type !== 'article' || !locales.length) return null;
  const pattern =
    choice === LONG_READ
      ? longReadPattern(locales)
      : choice === PHOTO_STORY && photos.length
        ? photoStoryPattern(photos, locales)
        : null;
  return pattern?.blocks.map(({ id: _id, ...block }) => block as BlockInput) ?? null;
}

/**
 * The blocks an empty document of `type` starts with when `choice` is picked: the standard long read
 * in `locales`, or a copy of one of the site's patterns without its block ids. The long read on a
 * page is refused like an unknown pattern.
 */
export async function chosenBlocks(
  principal: Principal,
  choice: string,
  type: ContentType,
  locales: readonly string[]
): Promise<BlockInput[]> {
  const standard = standardBlocks(choice, type, locales);
  if (standard) return standard;
  if (choice === LONG_READ || choice === PHOTO_STORY)
    throw new UseCaseError('invalid_input', 'No standard pattern for this item');
  const pattern = await runtime().invoker.run(useCases.getPattern, principal, {
    patternId: choice,
  });
  return pattern.blocks.map(({ id: _id, ...block }) => block as BlockInput);
}
