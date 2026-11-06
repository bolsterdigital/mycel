// The publication state machine per item and locale (ADR 012 rule 4, ADR 018 rules 1, 3 and 9),
// as pure functions over one locale's pointers. The use cases and the scheduled-publish job
// apply these under the item lock; nothing else moves a pointer.
//
// The status is derived, never stored on its own: published while a pointer exists, scheduled
// while only a pin exists, unpublished once it has been live, draft before that. Migration 0011
// computes the same column the same way, so the two cannot disagree. Rejected: a status column
// set by each transition, which can drift from the pointers it describes.

import type { LocaleStatus } from './model.js';

/**
 * A locale offered for publication by someone who may write ("Ter publicatie aanbieden"):
 * a mark beside the status, not a status of its own, so ADR 012's four stay as they are. `since`
 * is the moment of the first offer; saving or offering again later keeps it, so a publisher is
 * not pinged twice for one draft.
 */
export interface ReviewRequest {
  since: Date;
  note: string | null;
}

export interface LocaleState {
  locale: string;
  publishedRevisionId: string | null;
  publishedAt: Date | null;
  firstPublishedAt: Date | null;
  scheduledRevisionId: string | null;
  scheduledFor: Date | null;
  scheduleId: string | null;
  review: ReviewRequest | null;
}

export const draftLocale = (locale: string): LocaleState => ({
  locale,
  publishedRevisionId: null,
  publishedAt: null,
  firstPublishedAt: null,
  scheduledRevisionId: null,
  scheduledFor: null,
  scheduleId: null,
  review: null,
});

export function statusOf(s: LocaleState): LocaleStatus {
  if (s.publishedRevisionId) return 'published';
  if (s.scheduledRevisionId) return 'scheduled';
  return s.firstPublishedAt ? 'unpublished' : 'draft';
}

const unpinned = (s: LocaleState): LocaleState => ({
  ...s,
  scheduledRevisionId: null,
  scheduledFor: null,
  scheduleId: null,
});

/**
 * Put `revisionId` live. A manual publish replaces any planning for this locale (brief #8a § 3)
 * and answers an offer for publication. Publishing the revision that is already live, with
 * nothing planned or offered, changes nothing.
 */
export function publish(s: LocaleState, revisionId: string, at: Date): LocaleState {
  if (s.publishedRevisionId === revisionId && !s.scheduleId && !s.review) return s;
  return {
    ...unpinned(s),
    review: null,
    publishedRevisionId: revisionId,
    publishedAt: at,
    firstPublishedAt: s.firstPublishedAt ?? at,
  };
}

/** Take the locale offline and drop its planning; other locales are untouched. */
export function unpublish(s: LocaleState): LocaleState {
  return { ...unpinned(s), publishedRevisionId: null, publishedAt: null };
}

/**
 * Pin a revision for a time (ADR 018 rule 1). A new schedule replaces the old one; planning it
 * answers an offer for publication as publishing would.
 */
export function schedule(
  s: LocaleState,
  revisionId: string,
  at: Date,
  scheduleId: string
): LocaleState {
  return { ...s, scheduledRevisionId: revisionId, scheduledFor: at, scheduleId, review: null };
}

/**
 * Offer the locale for publication. An offer that stands keeps its moment and takes the new note,
 * so a correction to the note does not make it news again.
 */
export function requestReview(s: LocaleState, note: string | null, at: Date): LocaleState {
  return { ...s, review: { since: s.review?.since ?? at, note } };
}

/** Take the offer back; nothing else about the locale changes. */
export function withdrawReview(s: LocaleState): LocaleState {
  return s.review ? { ...s, review: null } : s;
}

/** Drop the pin; a live publication stays live. */
export function unschedule(s: LocaleState): LocaleState {
  return unpinned(s);
}

/**
 * What a `content.publish` job may do with this state: nothing (`stale`: cancelled, replaced,
 * or already done), wait (`early`: never publish before the pinned time), or publish the pin.
 */
export function scheduledRun(
  s: LocaleState | undefined,
  job: { scheduleId: string; revisionId: string },
  now: Date
): { kind: 'stale' } | { kind: 'early'; at: Date } | { kind: 'due'; revisionId: string } {
  if (!s || s.scheduleId !== job.scheduleId || s.scheduledRevisionId !== job.revisionId)
    return { kind: 'stale' };
  if (s.scheduledFor && now.getTime() < s.scheduledFor.getTime())
    return { kind: 'early', at: s.scheduledFor };
  return { kind: 'due', revisionId: job.revisionId };
}
