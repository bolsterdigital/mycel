// The public donation form over the memory adapter (brief MY-252 PR 2): a form of kind
// `donation` validates its amount (presets, an amount of one's own, the bounds of a payment),
// starts the payment in the submission's transaction and answers with the checkout; the payment
// names its submission until it settles, and settling makes the address a supporter through the
// ingest, with the donation event in their log. The scheduled reconciliation asks after payments
// left open. The Postgres side of the same record is `packages/db/src/money/donation-rule.ts`.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import type { FormDefinition } from '../forms/model.js';
import { FormDefinition as FormSchema } from '../forms/model.js';
import { evaluateFields } from '../forms/fields.js';
import {
  FakeClock,
  FakePaymentProvider,
  MemoryUnitOfWork,
  TENANT,
  expectCode,
  principal,
} from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { anonymousPrincipal } from '../principal.js';

import { RECONCILE_AFTER_MS, checkPayment, dueDonations } from './service.js';

const RETURN = 'http://localhost:5173/probe/donation/{token}';

async function setup(provider: FakePaymentProvider | null = new FakePaymentProvider()) {
  const clock = new FakeClock();
  const uow = new MemoryUnitOfWork({ clock, paymentProvider: provider });
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = principal({
    capabilities: [
      'content:write',
      'content:publish',
      'forms:read',
      'forms:write',
      'donations:read',
      'donations:write',
      'supporters:read',
    ],
  });
  const form = await invoker.run(useCases.createForm, admin, { kind: 'donation' });
  const give = (values: Record<string, string | boolean>, returnUrl: string | undefined = RETURN) =>
    invoker.run(useCases.submitForm, admin, {
      formId: form.id,
      values: { email: 'gever@example.org', ...values },
      locale: 'nl',
      ...(returnUrl ? { returnUrl } : {}),
    });
  const payments = () => invoker.run(useCases.listDonations, admin, {});
  return { clock, uow, invoker, admin, form, give, payments, provider };
}

describe('a donation form', () => {
  it('starts with the amount to choose, an address and an optional consent', async () => {
    const { form } = await setup();
    expect(form.kind).toBe('donation');
    expect(form.fields.map((f) => [f.type, f.required])).toEqual([
      ['amount', true],
      ['email', true],
      ['consent', false],
    ]);
    expect(form.fields[0]).toMatchObject({ presets: [10, 25, 50], custom: true, min: 1 });
    expect(form.submitLabel).toMatchObject({ nl: 'Doneer', en: 'Give' });
  });

  it('needs exactly one amount the visitor always gives', async () => {
    const { form } = await setup();
    const without = { ...form, fields: form.fields.filter((f) => f.type !== 'amount') };
    expect(FormSchema.safeParse(without).success).toBe(false);
    const optional = {
      ...form,
      fields: form.fields.map((f) => (f.type === 'amount' ? { ...f, required: false } : f)),
    };
    expect(FormSchema.safeParse(optional).success).toBe(false);
    const repeated = { ...form, presets: undefined, fields: [...form.fields] };
    repeated.fields[0] = {
      ...form.fields[0]!,
      presets: [10, 10, 25],
    } as FormDefinition['fields'][0];
    expect(FormSchema.safeParse(repeated).success).toBe(false);
  });

  it('reads a preset, and an amount of one’s own over a checked preset', () => {
    const field = {
      id: 'amount',
      name: 'amount',
      type: 'amount' as const,
      required: true,
      label: { nl: 'Bedrag' },
      presets: [10, 25, 50],
      custom: true,
    };
    expect(evaluateFields([field], { amount: '25' }).values).toEqual({ amount: 25 });
    expect(evaluateFields([field], { amount: '25', 'amount-other': '17,5' }).errors).toEqual([
      { field: 'amount', message: 'forms.error.value' },
    ]);
    expect(evaluateFields([field], { amount: '25', 'amount-other': '17.50' }).values).toEqual({
      amount: 17.5,
    });
    expect(evaluateFields([field], { amount: '30' }).errors).toHaveLength(1);
    expect(evaluateFields([field], { amount: '', 'amount-other': ' ' }).errors).toEqual([
      { field: 'amount', message: 'forms.error.required' },
    ]);
    // Without an amount of one's own the posted one is ignored and only presets count.
    const fixed = { ...field, custom: false };
    expect(evaluateFields([fixed], { amount: '10', 'amount-other': '99' }).values).toEqual({
      amount: 10,
    });
  });

  it('starts the payment and answers with the checkout; the payment names the submission', async () => {
    const { give, payments, provider } = await setup();
    const result = await give({ amount: '25' });
    expect(result).toMatchObject({ status: 'accepted' });
    if (result.status !== 'accepted') throw new Error('not accepted');
    const [payment] = (await payments()).donations;
    expect(payment).toMatchObject({
      status: 'open',
      amount: 2500,
      currency: 'EUR',
      description: 'Donatie',
      supporterId: null,
      submissionId: result.submissionId,
    });
    expect(result.checkoutUrl).toBe(`https://pay.example/checkout/fake_${payment!.id}`);
    expect(provider!.requests[0]!.returnUrl).toBe(
      `http://localhost:5173/probe/donation/${encodeURIComponent(result.token!)}`
    );
  });

  it('refuses an amount outside the field, before storing anything', async () => {
    const { give, payments, uow, admin, form } = await setup();
    expect(form.fields[0]).toMatchObject({ min: 1, max: 50_000 });
    for (const amount of ['0.5', '50000.01'])
      expect(await give({ amount: '', 'amount-other': amount })).toEqual({
        status: 'invalid',
        errors: [{ field: 'amount', message: 'forms.error.value' }],
      });
    expect((await payments()).donations).toEqual([]);
    expect(await uow.run(admin, async (ctx) => (await ctx.submissions.list(form.id)).length)).toBe(
      0
    );
  });

  it('refuses a gift below the payment minimum when the field allows it', async () => {
    const { invoker, admin, form, give } = await setup();
    const { version } = await invoker.run(useCases.getForm, admin, { id: form.id });
    await invoker.run(useCases.updateForm, admin, {
      baseVersion: version,
      value: {
        ...form,
        fields: form.fields.map((f) => (f.type === 'amount' ? { ...f, min: 0.5 } : f)),
      },
    });
    expect(await give({ amount: '', 'amount-other': '0.75' })).toEqual({
      status: 'invalid',
      errors: [{ field: 'amount', message: 'forms.error.donation-amount' }],
    });
  });

  it('needs a return address, and rolls the submission back when no payment can open', async () => {
    const plain = await setup();
    await expectCode(plain.give({ amount: '10' }, ''), 'invalid_input');
    const none = await setup(null);
    await expectCode(none.give({ amount: '10' }), 'conflict');
    const outage = await setup();
    outage.provider!.failNext();
    await expectCode(outage.give({ amount: '10' }), 'conflict');
    // Refused before anything is stored; the outage rolls back with the transaction (Postgres:
    // `donation-rule.ts`).
    expect(
      await none.uow.run(
        none.admin,
        async (ctx) => (await ctx.submissions.list(none.form.id)).length
      )
    ).toBe(0);
  });

  it('makes the donor a supporter when the payment settles, with the gift in their log', async () => {
    const { give, invoker, admin, provider, payments, uow } = await setup();
    const result = await give({ amount: '50' });
    if (result.status !== 'accepted') throw new Error('not accepted');
    // Before it settles the address gave nothing: no supporter yet.
    await expectCode(
      invoker.run(useCases.getSupporter, admin, { email: 'gever@example.org' }),
      'not_found'
    );
    const [open] = (await payments()).donations;
    provider!.settle(`fake_${open!.id}`, 'paid');
    expect(
      await invoker.run(useCases.checkDonation, admin, { token: result.token!, cause: 'return' })
    ).toMatchObject({ status: 'paid', amount: 5000 });
    const supporter = await invoker.run(useCases.getSupporter, admin, {
      email: 'gever@example.org',
    });
    const [paid] = (await payments()).donations;
    expect(paid).toMatchObject({ status: 'paid', supporterId: supporter.id });
    const events = await uow.run(admin, (ctx) => ctx.supporters.eventsFor(supporter.id));
    expect(events.map((e) => [e.type, e.props])).toEqual([
      ['donation.payment.succeeded', { payment_id: paid!.id, amount: 5000, currency: 'EUR' }],
    ]);
    // A second check changes nothing and appends nothing.
    await invoker.run(useCases.checkDonation, admin, { paymentId: paid!.id });
    expect(await uow.run(admin, (ctx) => ctx.supporters.eventsFor(supporter.id))).toHaveLength(1);
    expect(
      (await invoker.run(useCases.listDonations, admin, { supporterId: supporter.id })).donations
    ).toHaveLength(1);
  });

  it('notes a failed gift in the donor’s log as well', async () => {
    const { give, invoker, admin, provider, payments, uow } = await setup();
    await give({ amount: '10' });
    const [open] = (await payments()).donations;
    provider!.settle(`fake_${open!.id}`, 'failed', 'canceled');
    await invoker.run(useCases.checkDonation, admin, { paymentId: open!.id, cause: 'return' });
    const supporter = await invoker.run(useCases.getSupporter, admin, {
      email: 'gever@example.org',
    });
    const events = await uow.run(admin, (ctx) => ctx.supporters.eventsFor(supporter.id));
    expect(events.map((e) => e.type)).toEqual(['donation.payment.failed']);
  });

  it('may be given twice in a day, and subscribes a donor who ticks consent', async () => {
    const { give, payments, uow } = await setup();
    expect((await give({ amount: '10' })).status).toBe('accepted');
    expect((await give({ amount: '25', consent: true })).status).toBe('accepted');
    expect((await payments()).donations.map((d) => d.amount)).toEqual([2500, 1000]);
    expect(uow.store.outbox.filter((e) => e.type === 'newsletter.subscribed')).toHaveLength(1);
  });
});

describe('the donor’s return page', () => {
  it('reaches the one return use case with a token, and no other donation use case', async () => {
    const { give, invoker, provider, payments } = await setup();
    const result = await give({ amount: '25' });
    if (result.status !== 'accepted') throw new Error('not accepted');
    const visitor = anonymousPrincipal(TENANT, ['donations:write', 'donations:read']);
    const back = (token: string) => invoker.run(useCases.checkDonationReturn, visitor, { token });
    expect(await back(result.token!)).toMatchObject({
      status: 'open',
      amount: 2500,
      checkoutUrl: result.checkoutUrl,
    });
    const [open] = (await payments()).donations;
    provider!.settle(`fake_${open!.id}`, 'paid');
    expect(await back(result.token!)).toMatchObject({ status: 'paid', checkoutUrl: null });
    await expectCode(back(`${result.token}x`), 'not_found');
    // Whatever the front hands it, an anonymous visitor reaches no other donation use case.
    await expectCode(
      invoker.run(useCases.checkDonation, visitor, { paymentId: open!.id }),
      'forbidden'
    );
    await expectCode(invoker.run(useCases.listDonations, visitor, {}), 'forbidden');
  });
});

describe('the scheduled reconciliation', () => {
  it('asks after payments left open longer than a quarter of an hour', async () => {
    const { give, uow, admin, clock, provider, invoker } = await setup();
    await give({ amount: '10' });
    const due = () => uow.run(admin, (ctx) => dueDonations(ctx));
    expect(await due()).toEqual([]);
    clock.advance(RECONCILE_AFTER_MS + 1000);
    const [id] = await due();
    expect(id).toBeDefined();
    provider!.settle(`fake_${id}`, 'expired');
    expect(await uow.run(admin, (ctx) => checkPayment(ctx, id!, 'reconcile'))).toMatchObject({
      status: 'expired',
    });
    expect(await due()).toEqual([]);
    const { ledger } = await invoker.run(useCases.getDonation, admin, { paymentId: id! });
    expect(ledger.at(-1)).toMatchObject({ from: 'open', to: 'expired', cause: 'reconcile' });
  });
});
