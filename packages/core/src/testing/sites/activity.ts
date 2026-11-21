// What people did on a demo site (MY-264 PR 2): signed a petition, subscribed, signed up for an
// event, gave once or monthly, became a member or a reader, and received a newsletter. All of it
// goes through the public use cases a visitor's form reaches (`form.submit`, the confirmation link,
// the payment check), so the supporter log, participations, ledger and mail come out as they do
// for a real visitor. Three things lie outside the use cases and are the caller's: signing the
// confirmation link as the mail would (`uow`), delivering what the outbox holds to its
// subscribers as the worker would (`deliver`), and paying at the provider (`settle`).
// Idempotent per supporter: a definition whose address is already a supporter is left alone, and
// an item with an edition is not sent again.
// Rejected: writing supporter events with `ingest` (a participation needs a real submission, and
// the confirmation, consent and payment records would be missing), and waiting for the running
// worker instead of `deliver` (a grant needs the supporter the ingest makes, in this run).

import type { FieldValue, GiftInterval } from '../../forms/fields.js';
import { signConfirmToken } from '../../mailing/confirmation.js';
import type { UnitOfWork } from '../../ports.js';
import { useCases } from '../../use-cases.js';
import { named, type Run } from './runner.js';

export interface Activity {
  /** The site's root URL without a trailing slash: a gift's return page, a newsletter's links. */
  origin: string;
  /** Signs a confirmation link as the mail the visitor receives would. */
  uow: UnitOfWork;
  /** Every event published so far has reached its subscribers when this resolves. */
  deliver(): Promise<void>;
  /** The payment the provider knows as `providerRef` is paid, as if the donor paid it. */
  settle(providerRef: string): Promise<void>;
}

type Values = Record<string, FieldValue>;

export interface SupporterDef {
  key: string;
  email: string;
  /** The locale the forms are filled in; the site's default locale when absent. */
  locale?: string;
  /** Forms filled in and confirmed through the mailed link: a signup, petition or event. */
  joins?: { form: string; consent?: boolean; values?: Record<string, FieldValue> }[];
  /** Gifts and memberships through a donation or membership form, paid at once. */
  gives?: { form: string; amount?: number; interval?: GiftInterval; values?: Values }[];
  /** A message through a contact form; makes no supporter of its own. */
  writes?: { form: string; values: Record<string, FieldValue> }[];
  /** The key of a free tier given by hand: a reader of closed content (ADR 016). */
  reads?: string;
}

export async function seedActivity(run: Run, activity: Activity) {
  for (const def of run.site.supporters ?? [])
    await named(`supporter ${def.key}`, () => seedSupporter(run, activity, def));
  for (const key of run.site.editions ?? [])
    await named(`edition ${key}`, () => seedEdition(run, activity, key));
  await activity.deliver();
}

async function supporterOf(run: Run, email: string) {
  try {
    return await run.invoker.run(useCases.getSupporter, run.principal, { email });
  } catch (error) {
    if ((error as { code?: string }).code === 'not_found') return null;
    throw error;
  }
}

async function seedSupporter(run: Run, activity: Activity, def: SupporterDef) {
  const { invoker, principal, refs, site } = run;
  if (await supporterOf(run, def.email)) return;
  const locale = def.locale ?? site.defaultLocale;
  const submit = async (form: string, values: Record<string, FieldValue>, returnUrl?: string) => {
    const result = await invoker.run(useCases.submitForm, principal, {
      formId: refs.form(form),
      values: { email: def.email, ...values },
      locale,
      ...(returnUrl && { returnUrl }),
    });
    if (result.status !== 'accepted')
      throw new Error(`form ${form}: ${result.status} ${JSON.stringify(result)}`);
    return result;
  };

  for (const join of def.joins ?? []) {
    const { submissionId } = await submit(join.form, {
      ...(join.consent !== undefined && { consent: join.consent }),
      ...join.values,
    });
    await activity.deliver();
    const { form } = await invoker.run(useCases.getFormForAuthoring, principal, {
      id: refs.form(join.form),
    });
    const token = await activity.uow.run(principal, (ctx) =>
      signConfirmToken(
        ctx.signer,
        { tenantId: principal.tenantId, submissionId, list: form.list },
        ctx.clock.now()
      )
    );
    await invoker.run(useCases.confirmSubscription, principal, { token });
    await activity.deliver();
  }

  for (const gift of def.gives ?? []) {
    const { submissionId } = await submit(
      gift.form,
      {
        // Typed as an amount of one's own, so it need not be one of the presets.
        ...(gift.amount !== undefined && { amount: '', 'amount-other': String(gift.amount) }),
        ...(gift.interval && { 'amount-interval': gift.interval }),
        ...gift.values,
      },
      `${activity.origin}/donation/{token}`
    );
    const { donations } = await invoker.run(useCases.listDonations, principal, {});
    const payment = donations.find((d) => d.submissionId === submissionId);
    if (!payment) throw new Error(`form ${gift.form}: no payment for the submission`);
    await activity.settle(payment.providerRef);
    await invoker.run(useCases.checkDonation, principal, {
      paymentId: payment.id,
      cause: 'webhook',
    });
    await activity.deliver();
  }

  for (const message of def.writes ?? []) await submit(message.form, message.values);

  if (def.reads) {
    await activity.deliver();
    const supporter = await supporterOf(run, def.email);
    if (!supporter) throw new Error('a reader needs a supporter: give them a join or a gift');
    await invoker.run(useCases.createAccessGrant, principal, {
      supporterId: supporter.id,
      tierId: refs.tier(def.reads),
      kind: 'comp',
      reason: 'Demo site: a reader of the closed pages.',
    });
  }
  (run.created['supporter'] ??= []).push(def.key);
}

/** Send a published item once, in every published locale, to the subscribers of its list. */
async function seedEdition(run: Run, activity: Activity, key: string) {
  const { invoker, principal, refs, site } = run;
  const itemId = refs.item(key);
  const { editions } = await invoker.run(useCases.listEditions, principal, { itemId });
  if (editions.length) return;
  const { item } = await invoker.run(useCases.getItem, principal, { itemId });
  const locales = item.publication.filter((p) => p.status === 'published').map((p) => p.locale);
  await invoker.run(useCases.sendEdition, principal, {
    itemId,
    locales,
    site: { name: site.name, url: activity.origin, defaultLocale: site.defaultLocale },
  });
  (run.created['edition'] ??= []).push(key);
}
