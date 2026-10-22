// The publication state machine per item and locale (ADR 012 rule 4, ADR 018 rules 1, 3 and 9),
// as pure functions over one locale's pointers. The use cases and the scheduled-publish job
// apply these under the item lock; nothing else moves a pointer.
//
// The status is derived, never stored on its own: published while a pointer exists, scheduled
// while only a pin exists, unpublished once it has been live, draft before that. Migration 0011
// computes the same column the same way, so the two cannot disagree. Rejected: a status column
// set by each transition, which can drift from the pointers it describes.

import type { LocaleStatus } from './model.js';

export interface LocaleState {
  locale: string;
  publishedRevisionId: string | null;
  publishedAt: Date | null;
  firstPublishedAt: Date | null;
  scheduledRevisionId: string | null;
  scheduledFor: Date | null;
  scheduleId: string | null;
}

export const draftLocale = (locale: string): LocaleState => ({
  locale,
  publishedRevisionId: null,
  publishedAt: null,
  firstPublishedAt: null,
  scheduledRevisionId: null,
  scheduledFor: null,
  scheduleId: null,
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
 * Put `revisionId` live. A manual publish replaces any planning for this locale (brief #8a § 3).
 * Publishing the revision that is already live, with nothing planned, changes nothing.
 */
export function publish(s: LocaleState, revisionId: string, at: Date): LocaleState {
  if (s.publishedRevisionId === revisionId && !s.scheduleId) return s;
  return {
    ...unpinned(s),
    publishedRevisionId: revisionId,
    publishedAt: at,
    firstPublishedAt: s.firstPublishedAt ?? at,
  };
}

/** Take the locale offline and drop its planning; other locales are untouched. */
export function unpublish(s: LocaleState): LocaleState {
  return { ...unpinned(s), publishedRevisionId: null, publishedAt: null };
}

/** Pin a revision for a time (ADR 018 rule 1). A new schedule replaces the old one. */
export function schedule(
  s: LocaleState,
  revisionId: string,
  at: Date,
  scheduleId: string
): LocaleState {
  return { ...s, scheduledRevisionId: revisionId, scheduledFor: at, scheduleId };
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
