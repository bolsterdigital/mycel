// Supporter event envelope, inherited from the Dreamkit contract `wings.supporter-event.v1`
// (ADR 003). The schema id is kept so that a backfill from dreamkit-supporter-registry needs no
// translation. New event types are additions to `SupporterEventType`; a changed meaning is a new
// schema id, never an edit.

import { z } from 'zod';
import { normalizeEmail } from '../util/email.js';

export const SupporterEventType = z.enum([
  'petition.signed',
  'form.submitted',
  'newsletter.subscribed',
  'newsletter.unsubscribed',
  'consent.given',
  'consent.withdrawn',
  'donation.started',
  'donation.payment.succeeded',
  'donation.payment.failed',
  'donation.subscription.cancelled',
  'event.rsvp',
  'membership.started',
  'membership.renewed',
  'membership.ended',
  'supporter.erased',
  'supporter.email_changed',
]);
export type SupporterEventType = z.infer<typeof SupporterEventType>;

export const SupporterEvent = z.object({
  schema: z.literal('wings.supporter-event.v1'),
  /** Deterministic dedup key: sha1(source | source_ref | type | occurred_at). */
  id: z.string().min(1),
  /**
   * Stable supporter id (ADR 019 rule 1), an envelope addition: ingest assigns it when it resolves
   * the e-mail address, so a backfill or another producer never has to supply it.
   */
  supporter_id: z.string().guid().optional(),
  type: SupporterEventType,
  /**
   * Lowercased and trimmed; resolves to `supporter_id` at ingest (ADR 019 rule 1). For
   * `supporter.email_changed` it is the address before the change.
   */
  email: z.preprocess((v) => (typeof v === 'string' ? normalizeEmail(v) : v), z.string().email()),
  occurred_at: z.string().datetime({ offset: true }),
  source: z.string().min(1),
  source_site: z.string().url(),
  source_ref: z.string().min(1),
  /** Type-specific extras. No special-category personal data beyond what the type implies. */
  props: z.record(z.string(), z.unknown()).default({}),
});
export type SupporterEvent = z.infer<typeof SupporterEvent>;
