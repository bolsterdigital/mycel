// The edit screen's outcomes as admin copy: the notice after an action (`done` of its redirect)
// and core's issue keys on a save, a publication and a new slug. Apart from the route because
// they are tables, not behaviour. Rejected: one catalogue per front in core, which holds no copy.

import type { UiKey } from '../../../i18n/index.js';

/** The notice after a publication action, by the `done` parameter of its redirect. */
export const DONE: Record<string, UiKey> = {
  blockMoved: 'admin.block.done.moved',
  blockDuplicated: 'admin.block.done.duplicated',
  blockRemoved: 'admin.block.done.removed',
  blockRestored: 'admin.block.done.restored',
  heroConverted: 'admin.content.heroConversion.done',
  publish: 'admin.content.publication.done.publish',
  unpublish: 'admin.content.publication.done.unpublish',
  schedule: 'admin.content.publication.done.schedule',
  repin: 'admin.content.publication.done.schedule',
  unschedule: 'admin.content.publication.done.unschedule',
  offer: 'admin.content.review.done.offer',
  withdrawOffer: 'admin.content.review.done.withdraw',
  translationApproved: 'admin.assist.approved',
};

/** Core's readiness and reference issues as admin copy; unknown keys get the generic line. */
export const ISSUE_COPY: Record<string, UiKey> = {
  'content.publish.locale-not-in-document': 'admin.content.issue.localeNotInDocument',
  'content.publish.locale-not-in-item': 'admin.content.issue.localeNotInDocument',
  'content.publish.missing-translation': 'admin.content.issue.missingTranslation',
  'content.publish.machine-translation-unreviewed': 'admin.assist.unreviewed',
  'content.publish.teaser-lead-required': 'admin.content.issue.teaserLeadRequired',
  'content.publish.tier-unverifiable': 'admin.content.issue.tierUnverifiable',
  'content.reference.author-unknown': 'admin.content.issue.referenceUnknown',
  'content.reference.section-unknown': 'admin.content.issue.referenceUnknown',
  'content.reference.item-unknown': 'admin.content.issue.referenceUnknown',
  'content.reference.form-unknown': 'admin.content.issue.referenceUnknown',
  'content.reference.campaign-unknown': 'admin.content.issue.referenceUnknown',
  'content.reference.media-unknown': 'admin.content.issue.referenceUnknown',
  'content.reference.media-not-image': 'admin.content.issue.mediaNotImage',
  'content.reference.media-not-document': 'admin.content.issue.mediaNotDocument',
  'content.reference.media-not-audio': 'admin.content.issue.mediaNotAudio',
  'content.schedule.not-in-future': 'admin.content.issue.notInFuture',
  'admin.content.publication.time-invalid': 'admin.content.issue.timeInvalid',
  'content.review.nothing-new': 'admin.content.issue.reviewNothingNew',
};
export const issueCopy = (message: string): UiKey =>
  ISSUE_COPY[message] ?? 'admin.content.issue.other';

/** Core's issue keys on a save, as admin copy; anything else is the generic invalid message. */
export const ISSUES: Record<string, UiKey> = {
  'i18n.default-not-in-locales': 'admin.content.error.defaultLocale',
  'content.seo.canonical.invalid': 'admin.content.error.canonical',
  'content.tag.invalid': 'admin.content.error.tag',
  'content.access.marker-needs-one-paywall': 'admin.content.error.marker',
  'content.access.paywall-without-marker': 'admin.content.error.paywallWithoutMarker',
  'content.access.teaser-too-long': 'admin.content.error.teaserTooLong',
  'content.access.tier-ids-required': 'admin.content.error.tier',
  'content.image.alt-required': 'admin.block.issue.altRequired',
  'content.image.alt-empty': 'admin.block.issue.altRequired',
};

/** Core's refusals of a new slug, as admin copy. */
export const SLUG_ISSUES: Record<string, UiKey> = {
  'content.slug.invalid': 'admin.content.error.slugInvalid',
  'content.slug.reserved': 'admin.content.error.slugReserved',
  'content.slug.taken': 'admin.content.error.slugTaken',
  'content.slug.published': 'admin.content.error.slugPublished',
};
