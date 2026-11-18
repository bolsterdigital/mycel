// "Send me a sign-in link" on the return page of a membership (ADR 016 rule 1, brief MY-254 PR 4).
// A payment never signs anyone in: whoever holds the return page's address is not proven to own
// the member's mailbox. The page offers a button instead that mails the ordinary sign-in link to
// the address that paid; whoever opens it there signs in as usual.
//
// The return token is the capability, as on `donation.return.check`: it names one payment of this
// site, and the use case reaches only the address of that payment's supporter, which it never
// returns. The sign-in mail's own refusals apply (an erased address, one mail per address per
// day), and every refusal answers the same, so the page learns nothing it did not know.
// Rejected: signing the payer in from the return page (a shared or forwarded link would sign in
// whoever opened it), and the reader's sign-in form with the address typed again (the payer just
// typed it on the membership form).

import { z } from 'zod';
import { Locale } from '../i18n/locale.js';
import { defineUseCase } from '../registry.js';
import { mailSigninLink } from '../readers/service.js';
import { isTombstone } from '../supporters/erasure.js';
import '../supporters/ports.js';
import './ports.js';
import { paymentOfToken } from './service.js';

export const requestMemberSignin = defineUseCase({
  name: 'donation.signin.request',
  kind: 'command',
  description:
    'From the return page of a paid membership: mail a sign-in link to the address that paid, so the new member can read what the membership opens. The return `token` names the payment; the address is never returned. Always answers accepted, also when nothing is sent (not a paid membership, an erased address, a link already mailed today).',
  requires: 'donations:write',
  input: z
    .object({
      token: z.string().min(1).max(500),
      locale: Locale,
      /** A path on this site to go back to after sign-in; anything else is dropped. */
      returnPath: z.string().max(500).optional(),
    })
    .strict(),
  output: z.object({ status: z.literal('accepted') }),
  examples: [{ input: { token: 'donation:example~signature', locale: 'nl' } }],
  async handler(ctx, { token, locale, returnPath }) {
    const accepted = { status: 'accepted' } as const;
    const refuse = (reason: string) => {
      ctx.log.info('donation.signin.refused', { reason });
      return accepted;
    };
    const payment = await ctx.payments.get(await paymentOfToken(ctx, token));
    if (!payment || payment.status !== 'paid' || payment.kind !== 'membership')
      return refuse('no-membership');
    if (!payment.supporterId) return refuse('no-member');
    const member = await ctx.supporters.getProjectionById(payment.supporterId);
    if (!member || isTombstone(member.email)) return refuse('no-member');
    const refused = await mailSigninLink(ctx, member.email, locale, returnPath);
    return refused ? refuse(refused) : accepted;
  },
});
