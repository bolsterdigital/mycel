// Mailing use cases. Double opt-in is two steps on the public site (ADR 010 rule 5): the link
// from the confirmation mail opens a page that only reads (`mailing.opt_in.get`), and the
// button on that page posts `mailing.opt_in.confirm`, which turns consent into a logged fact. A link
// scanner or a mail client's preview fetch therefore records nothing. Rejected: confirming on the
// GET of the link (the probe did; a scanner then consents for the person) and a JavaScript-only
// confirmation (ADR 009: the page works without it).
//
// What is confirmed is the snapshot on the submission (list, consent text version, locale), not
// the form's current definition: a form edited after the signup cannot change what a click
// confirms. Idempotent through `form_submissions.confirmed_at`, not through the event id: the id
// carries `occurred_at`, so two clicks would be two events. Rejected: a dedicated `consents`
// table, a second copy of what the submission row and the supporter log already hold.

import { z } from 'zod';
import type { ConsentGivenProps, ParticipationConfirmedProps } from '../forms/events.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { verifyConfirmToken } from './confirmation.js';
import './ports.js';

/**
 * What the link confirms, so the page can say it (B2 review R1): `participation` when it confirms
 * only a campaign signature, `subscription` when it confirms Mycel-owned consent (with or without
 * a signature). Absent when the token is invalid.
 */
const Purpose = z.enum(['subscription', 'participation']);

export const ConfirmResult = z.object({
  /** `invalid` covers a forged, expired or foreign token, a list mismatch and a vanished submission. */
  status: z.enum(['confirmed', 'already_confirmed', 'invalid']),
  /** The locale of the signup, so the answer is in the language the person signed up in. */
  locale: z.string().optional(),
  purpose: Purpose.optional(),
});
export type ConfirmResult = z.infer<typeof ConfirmResult>;

export const ConfirmPreview = z.object({
  status: z.enum(['pending', 'already_confirmed', 'invalid']),
  /** The locale of the signup; absent when the token is invalid. */
  locale: z.string().optional(),
  purpose: Purpose.optional(),
});
export type ConfirmPreview = z.infer<typeof ConfirmPreview>;

const ConfirmInput = z.object({ token: z.string().min(1) });

/**
 * The submission a token confirms, with its address and what the click grants, or null when the
 * token is worth nothing: forged or expired, for another tenant, for a submission that is gone, or
 * for a list other than the one on the submission. A list is never swapped for another (ADR 010
 * rule 6). `consent` is Mycel's to confirm only with a ticked, active consent field and no external
 * owner; a submission to a campaign's form is confirmed for the campaign either way (ADR 033 rule
 * 7), and that grants no list.
 */
async function resolveToken(ctx: TransactionContext, token: string, now: Date) {
  const payload = await verifyConfirmToken(ctx.signer, token, now);
  // The tenant in the token must be the tenant being visited (ADR 002 rule 3): a link for one
  // site never confirms anything on another.
  if (!payload || payload.tenantId !== ctx.principal.tenantId) return null;
  const submission = await ctx.submissions.findById(payload.submissionId);
  if (!submission || submission.list !== payload.list) return null;
  const external =
    (await ctx.formFeeds.get()).value.feeds.some(
      (f) => f.enabled && f.scope === submission.list && f.confirmationOwner === 'external'
    ) || !!submission.evaluation?.feedActions?.some((p) => p.feed.confirmationOwner === 'external');
  // The form only names the e-mail field; what is confirmed comes from the submission.
  const form = submission.evaluation?.definition ?? (await ctx.forms.findById(submission.formId));
  const ticked =
    !submission.evaluation ||
    !!form?.fields.some(
      (f) =>
        f.type === 'consent' &&
        submission.evaluation!.activeFieldIds.includes(f.id ?? f.name) &&
        submission.values[f.name] === true
    );
  const consent = ticked && !external;
  const campaignId = submission.evaluation?.campaignId;
  if (!consent && !campaignId) return null;
  const emailField = form?.fields.find((f) => f.type === 'email');
  const email = emailField ? submission.values[emailField.name] : undefined;
  if (typeof email !== 'string' || !email) return null;
  await ctx.supporters.lock(email);
  if (!(await ctx.erasures.allows(email, submission.evaluation?.supporterLifecycleId))) return null;
  const purpose: z.infer<typeof Purpose> = consent ? 'subscription' : 'participation';
  return { submission, email, consent, campaignId, kind: form?.kind, purpose };
}

export const previewConfirmation = defineUseCase({
  name: 'mailing.opt_in.get',
  kind: 'query',
  description:
    'Read what a double opt-in link would confirm, without confirming it: pending, already confirmed or invalid, with the locale of the signup.',
  requires: 'forms:write',
  input: ConfirmInput,
  output: ConfirmPreview,
  examples: [
    {
      input: { token: 'not-a-signed-token' },
      note: 'A forged or expired token gives status "invalid"; nothing is written for any status.',
    },
  ],
  async handler(ctx, { token }): Promise<ConfirmPreview> {
    const found = await resolveToken(ctx, token, ctx.clock.now());
    if (!found) return { status: 'invalid' };
    const { submission, consent, campaignId, purpose } = found;
    const done =
      (!consent || !!submission.confirmedAt) &&
      (!campaignId || !!submission.participationConfirmedAt);
    return { status: done ? 'already_confirmed' : 'pending', locale: submission.locale, purpose };
  },
});

export const confirmSubscription = defineUseCase({
  name: 'mailing.opt_in.confirm',
  kind: 'command',
  description:
    'Confirm a double opt-in: records consent for the list of the submission once and publishes consent.given, and for a campaign form records the signature (petition.signed or form.submitted); a second confirmation or an invalid token is an outcome, not an error.',
  requires: 'forms:write',
  input: ConfirmInput,
  output: ConfirmResult,
  examples: [
    {
      input: { token: 'not-a-signed-token' },
      note: 'A forged or expired token gives status "invalid"; the page shows a plain message.',
    },
  ],
  async handler(ctx, { token }): Promise<ConfirmResult> {
    const { principal, clock } = ctx;
    const now = clock.now();
    const found = await resolveToken(ctx, token, now);
    if (!found) return { status: 'invalid' };
    const { submission, email, consent, campaignId, kind, purpose } = found;
    const { locale } = submission;

    // Two facts, each with its own idempotency (ADR 033 rule 7): the signature and Mycel-owned
    // consent. One link may grant both; with an external consent owner the provider confirms
    // consent on its own clock, and neither confirmation may make the other a no-op.
    const signs = !!campaignId && (await ctx.submissions.confirmParticipation(submission.id, now));
    const consents = consent && (await ctx.submissions.confirm(submission.id, now));
    if (!signs && !consents) return { status: 'already_confirmed', locale, purpose };

    // ADR 033 rule 7: the confirmation makes the signature count. Ingest records it once the
    // supporter id exists; a signature is never consent, which follows below only when ticked.
    if (campaignId && signs) {
      const signed: ParticipationConfirmedProps = {
        email,
        formId: submission.formId,
        submissionId: submission.id,
        campaignId,
        locale,
        confirmedAt: now.toISOString(),
        supporterLifecycleId: submission.evaluation?.supporterLifecycleId,
      };
      await ctx.events.publish({
        id: ctx.ids.next(),
        type: kind === 'petition' ? 'petition.signed' : 'form.submitted',
        tenantId: principal.tenantId,
        occurredAt: now,
        actor: principal.actor,
        props: { ...signed },
      });
    }
    if (!consents) return { status: 'confirmed', locale, purpose };

    const props: ConsentGivenProps = {
      email,
      list: submission.list,
      formId: submission.formId,
      submissionId: submission.id,
      locale,
      consentTextVersion: submission.consentTextVersion,
      confirmedAt: now.toISOString(),
      supporterLifecycleId: submission.evaluation?.supporterLifecycleId,
    };
    await ctx.events.publish({
      id: ctx.ids.next(),
      type: 'consent.given',
      tenantId: principal.tenantId,
      occurredAt: now,
      actor: principal.actor,
      props: { ...props },
    });
    return { status: 'confirmed', locale, purpose };
  },
});
