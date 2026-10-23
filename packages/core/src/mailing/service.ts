// Mailing use cases. Double opt-in is two steps on the public site (ADR 010 rule 5): the link
// from the confirmation mail opens a page that only reads (`mailing.confirm.preview`), and the
// button on that page posts `mailing.confirm`, which turns consent into a logged fact. A link
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
import type { ConsentGivenProps } from '../forms/events.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { verifyConfirmToken } from './confirmation.js';
import './ports.js';

export const ConfirmResult = z.object({
  /** `invalid` covers a forged, expired or foreign token, a list mismatch and a vanished submission. */
  status: z.enum(['confirmed', 'already_confirmed', 'invalid']),
  /** The locale of the signup, so the answer is in the language the person signed up in. */
  locale: z.string().optional(),
});
export type ConfirmResult = z.infer<typeof ConfirmResult>;

export const ConfirmPreview = z.object({
  status: z.enum(['pending', 'already_confirmed', 'invalid']),
  /** The locale of the signup; absent when the token is invalid. */
  locale: z.string().optional(),
});
export type ConfirmPreview = z.infer<typeof ConfirmPreview>;

const ConfirmInput = z.object({ token: z.string().min(1) });

/**
 * The submission a token confirms, with its address, or null when the token is worth nothing:
 * forged or expired, for another tenant, for a submission that is gone, or for a list other than
 * the one on the submission. A list is never swapped for another (ADR 010 rule 6).
 */
async function resolveToken(ctx: TransactionContext, token: string, now: Date) {
  const payload = await verifyConfirmToken(ctx.signer, token, now);
  // The tenant in the token must be the tenant being visited (ADR 002 rule 3): a link for one
  // site never confirms anything on another.
  if (!payload || payload.tenantId !== ctx.principal.tenantId) return null;
  const submission = await ctx.submissions.findById(payload.submissionId);
  if (!submission || submission.list !== payload.list) return null;
  // The form only names the e-mail field; what is confirmed comes from the submission.
  const form = await ctx.forms.findById(submission.formId);
  const emailField = form?.fields.find((f) => f.type === 'email');
  const email = emailField ? submission.values[emailField.name] : undefined;
  if (typeof email !== 'string' || !email) return null;
  return { submission, email };
}

export const previewConfirmation = defineUseCase({
  name: 'mailing.confirm.preview',
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
    const { submission } = found;
    return {
      status: submission.confirmedAt ? 'already_confirmed' : 'pending',
      locale: submission.locale,
    };
  },
});

export const confirmSubscription = defineUseCase({
  name: 'mailing.confirm',
  kind: 'command',
  description:
    'Confirm a double opt-in: records consent for the list of the submission once and publishes consent.given; a second confirmation or an invalid token is an outcome, not an error.',
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
    const { submission, email } = found;
    const { locale } = submission;

    if (!(await ctx.submissions.confirm(submission.id, now)))
      return { status: 'already_confirmed', locale };

    const props: ConsentGivenProps = {
      email,
      list: submission.list,
      formId: submission.formId,
      submissionId: submission.id,
      locale,
      consentTextVersion: submission.consentTextVersion,
      confirmedAt: now.toISOString(),
    };
    await ctx.events.publish({
      id: ctx.ids.next(),
      type: 'consent.given',
      tenantId: principal.tenantId,
      occurredAt: now,
      actor: principal.actor,
      props: { ...props },
    });
    return { status: 'confirmed', locale };
  },
});
