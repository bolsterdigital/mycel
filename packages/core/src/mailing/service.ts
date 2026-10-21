// Mailing use cases. `mailing.confirm` is the second step of the public signup flow (ADR 010
// rule 5): the visitor follows the link from the confirmation mail and consent becomes a logged
// fact. Idempotent through `form_submissions.confirmed_at`, not through the event id: the id
// carries `occurred_at`, so two clicks would be two events. Rejected: a dedicated `consents`
// table, a second copy of what the submission row and the supporter log already hold.

import { z } from 'zod';
import type { ConsentGivenProps } from '../forms/events.js';
import { defineUseCase } from '../registry.js';
import { verifyConfirmToken } from './confirmation.js';
import './ports.js';

export const ConfirmResult = z.object({
  /** `invalid` covers a forged, expired or foreign token and a vanished submission. */
  status: z.enum(['confirmed', 'already_confirmed', 'invalid']),
});
export type ConfirmResult = z.infer<typeof ConfirmResult>;

export const confirmSubscription = defineUseCase({
  name: 'mailing.confirm',
  kind: 'command',
  description:
    'Follow a double opt-in link: records consent for the list once and publishes consent.given; a second click or an invalid token is an outcome, not an error.',
  requires: 'forms:write',
  input: z.object({ token: z.string().min(1) }),
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
    const invalid: ConfirmResult = { status: 'invalid' };

    const payload = await verifyConfirmToken(ctx.signer, token, now);
    // The tenant in the token must be the tenant being visited (ADR 002 rule 3): a link for one
    // site never confirms anything on another.
    if (!payload || payload.tenantId !== principal.tenantId) return invalid;

    const submission = await ctx.submissions.findById(payload.submissionId);
    if (!submission) return invalid;
    const form = await ctx.forms.findById(submission.formId);
    if (!form || form.list !== payload.list) return invalid;
    const emailField = form.fields.find((f) => f.type === 'email');
    const email = emailField ? submission.values[emailField.name] : undefined;
    if (typeof email !== 'string' || !email) return invalid;

    if (!(await ctx.submissions.confirm(submission.id, now)))
      return { status: 'already_confirmed' };

    const props: ConsentGivenProps = {
      email,
      list: form.list,
      formId: form.id,
      submissionId: submission.id,
      locale: submission.locale,
      consentTextVersion: form.consentTextVersion,
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
    return { status: 'confirmed' };
  },
});
