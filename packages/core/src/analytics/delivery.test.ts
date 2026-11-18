// Measurement, third part: the accepted-signup intent and its subscriber (docs/reference/
// analytics.md § Server events). An accepted public signup on a measuring site publishes one
// intent that carries the catalogue event and nothing else; every other outcome publishes none.
// The subscriber sends it at most once, rereads the setting, never retries a delivery that may
// have arrived and never lets the provider reach the form.
import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal, systemPrincipal } from '../principal.js';
import {
  FakeClock,
  MemoryLogger,
  MemoryTenants,
  MemoryUnitOfWork,
  hostedPlatform,
  principal,
  probeForm,
  probeTenant,
  solveProof,
  TENANT,
} from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { issueProofChallenge } from '../forms/proof.js';
import { signConfirmToken } from '../mailing/confirmation.js';
import type { DomainEvent } from '../ports.js';
import type { FormKind } from '../forms/model.js';
import { ANALYTICS_INTENT } from './events.js';
import {
  ANALYTICS_DELIVERY_WINDOW_MS,
  analyticsSubscriber,
  deliverAnalyticsIntent,
  type AnalyticsDeliveryDeps,
} from './delivery.js';
import type { AnalyticsDelivery } from './model.js';
import type { Analytics, AnalyticsOutcome } from './ports.js';

const OTHER = '01900000-0000-7000-8000-00000000bb12';
const FORM = '01900000-0000-7000-8000-00000000f000';
const ADDRESS = 'ada@example.org';

/** Records every delivery and answers from a script, `accepted` once the script runs out. */
class RecordingAnalytics implements Analytics {
  readonly sent: AnalyticsDelivery[] = [];
  constructor(private readonly answers: (AnalyticsOutcome | 'throw')[] = []) {}
  async send(delivery: AnalyticsDelivery): Promise<AnalyticsOutcome> {
    this.sent.push(delivery);
    const answer = this.answers.shift() ?? 'accepted';
    if (answer === 'throw') throw new Error(`socket hang up for ${ADDRESS}`);
    return answer;
  }
}

describe('analytics intent and delivery', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let log: MemoryLogger;

  beforeEach(async () => {
    clock = new FakeClock();
    log = new MemoryLogger();
    uow = new MemoryUnitOfWork({ clock, platform: hostedPlatform });
    invoker = new Invoker(buildRegistry(), uow);
    for (const [tenant, slug] of [
      [TENANT, 'probe'],
      [OTHER, 'other'],
    ] as const) {
      uow.store.addPlatformHostname({ ...probeTenant(tenant), slug }, hostedPlatform.domain);
      await uow.run(systemPrincipal(tenant, 'test'), (ctx) => ctx.forms.insert(probeForm(FORM)));
    }
    await measure(TENANT, 'probe.mycel.site');
  });

  async function measure(tenantId: string, plausibleDomain: string | null) {
    const admin = principal({ tenantId });
    const { version } = await invoker.run(useCases.getAnalyticsSettings, admin, {});
    await invoker.run(useCases.updateAnalyticsSettings, admin, {
      baseVersion: version,
      settings: { plausibleDomain },
    });
  }

  function deps(analytics: Analytics): AnalyticsDeliveryDeps {
    return {
      uow,
      tenants: new MemoryTenants([
        { ...probeTenant(TENANT), slug: 'probe' },
        { ...probeTenant(OTHER), slug: 'other' },
      ]),
      platform: hostedPlatform,
      analytics,
      clock,
      log,
    };
  }

  /** A visitor's post through the whole spam defence, as the public form sends it. */
  async function submit(
    values: Record<string, string | boolean>,
    opts: { tenantId?: string; honeypot?: string; ip?: string } = {}
  ) {
    const tenantId = opts.tenantId ?? TENANT;
    const { startedToken } = await invoker.run(
      useCases.getForm,
      anonymousPrincipal(tenantId, ['content:read', 'forms:read']),
      { id: FORM }
    );
    const challenge = await uow.run(systemPrincipal(tenantId, 'test'), (ctx) =>
      issueProofChallenge(ctx.signer, FORM, clock.now(), 20)
    );
    clock.advance(4000);
    return invoker.run(
      useCases.submitForm,
      anonymousPrincipal(tenantId, ['forms:write'], opts.ip ?? 'ip-1'),
      {
        formId: FORM,
        values,
        locale: 'nl',
        pageUrl: 'https://probe.mycel.site/aanmelden?token=secret&email=ada%40example.org',
        spam: {
          startedToken,
          honeypot: opts.honeypot ?? '',
          proof: await solveProof(challenge),
        },
      }
    );
  }

  const intents = (): DomainEvent[] =>
    uow.store.outbox.filter((event) => event.type === ANALYTICS_INTENT);

  it('publishes one intent per accepted public signup, with the catalogue event and nothing else', async () => {
    expect(await submit({ email: ADDRESS, consent: true })).toMatchObject({ status: 'accepted' });
    expect(await submit({ email: 'bo@example.org', consent: true }, { ip: 'ip-2' })).toMatchObject({
      status: 'accepted',
    });
    expect(intents()).toHaveLength(2);
    const [intent] = intents();
    expect(intent!.props).toEqual({ name: 'form.submitted', props: { kind: 'signup' } });
    // The visitor's channel stays; the IP hash, address, form, submission and page URL do not.
    expect(intent!.actor).toEqual({ kind: 'anonymous', channel: 'web' });
    const stored = JSON.stringify(intent);
    for (const absent of [ADDRESS, FORM, 'secret', 'aanmelden', 'newsletter', 'ip-1'])
      expect(stored).not.toContain(absent);
  });

  it('publishes nothing for an invalid, rejected, non-signup, integration or unmeasured submission', async () => {
    expect(await submit({ email: 'not-an-address', consent: true })).toMatchObject({
      status: 'invalid',
    });
    expect(await submit({ email: ADDRESS, consent: true }, { honeypot: 'bot' })).toMatchObject({
      status: 'rejected',
    });
    // An integration's post is not a public signup.
    expect(
      await invoker.run(useCases.submitForm, systemPrincipal(TENANT, 'import'), {
        formId: FORM,
        values: { email: 'import@example.org', consent: true },
        locale: 'nl',
      })
    ).toMatchObject({ status: 'accepted' });
    // The other site does not measure.
    expect(
      await submit({ email: ADDRESS, consent: true }, { tenantId: OTHER, ip: 'ip-3' })
    ).toMatchObject({ status: 'accepted' });
    // Only a signup form counts: a contact form or petition is not in the catalogue.
    for (const [kind, n] of [
      ['contact', 4],
      ['petition', 5],
    ] as [FormKind, number][]) {
      await uow.run(systemPrincipal(TENANT, 'test'), (ctx) =>
        ctx.forms.insert({ ...probeForm(FORM), kind })
      );
      expect(
        await submit({ email: `k${n}@example.org`, consent: true }, { ip: `ip-${n}` })
      ).toMatchObject({ status: 'accepted' });
    }
    expect(intents()).toEqual([]);
  });

  it('publishes nothing when the address is confirmed', async () => {
    const result = await submit({ email: ADDRESS, consent: true });
    if (result.status !== 'accepted') throw new Error(result.status);
    uow.store.outbox.length = 0;
    const token = await signConfirmToken(
      uow.signer,
      { tenantId: TENANT, submissionId: result.submissionId, list: 'newsletter' },
      clock.now()
    );
    expect(
      await invoker.run(
        useCases.confirmSubscription,
        anonymousPrincipal(TENANT, ['forms:write'], 'ip-1'),
        { token }
      )
    ).toMatchObject({ status: 'confirmed' });
    expect(uow.store.outbox.map((event) => event.type)).toEqual(['consent.given']);
  });

  it('sends the site root and the event of the measuring tenant only, and logs no person or site', async () => {
    await measure(OTHER, 'other.example');
    await submit({ email: ADDRESS, consent: true });
    await submit({ email: ADDRESS, consent: true }, { tenantId: OTHER, ip: 'ip-2' });
    await measure(OTHER, null);
    const analytics = new RecordingAnalytics();
    await uow.drain([analyticsSubscriber(deps(analytics))]);
    // The other site switched off after its visitor's signup: its queued intent sends nothing.
    expect(analytics.sent).toEqual([
      {
        domain: 'probe.mycel.site',
        url: 'https://probe.mycel.site/',
        event: { name: 'form.submitted', props: { kind: 'signup' } },
      },
    ]);
    expect(log.lines.map((line) => [line.level, line.fields['result']])).toEqual([
      ['info', 'accepted'],
      ['info', 'off'],
    ]);
    const logged = JSON.stringify(log.lines);
    for (const absent of [ADDRESS, 'probe.mycel.site', 'other.example', FORM])
      expect(logged).not.toContain(absent);
  });

  it('sends a redelivered intent once', async () => {
    await submit({ email: ADDRESS, consent: true });
    const [intent] = intents();
    const analytics = new RecordingAnalytics();
    expect(await deliverAnalyticsIntent(deps(analytics), intent!)).toBe('accepted');
    expect(await deliverAnalyticsIntent(deps(analytics), intent!)).toBe('duplicate');
    clock.advance(30 * 60 * 1000);
    expect(await deliverAnalyticsIntent(deps(analytics), intent!)).toBe('duplicate');
    expect(analytics.sent).toHaveLength(1);
  });

  it('retries only what was never sent, once, and never what may have arrived', async () => {
    for (let n = 0; n < 4; n++)
      await submit({ email: `v${n}@example.org`, consent: true }, { ip: `ip-${n}` });
    const [a, b, c, d] = intents();
    const run = async (event: DomainEvent, answers: (AnalyticsOutcome | 'throw')[]) => {
      const analytics = new RecordingAnalytics(answers);
      return [await deliverAnalyticsIntent(deps(analytics), event), analytics.sent.length];
    };
    expect(await run(a!, ['retryable'])).toEqual(['accepted', 2]);
    expect(await run(b!, ['retryable', 'retryable'])).toEqual(['retryable', 2]);
    expect(await run(c!, ['unknown'])).toEqual(['unknown', 1]);
    expect(await run(d!, ['throw'])).toEqual(['unknown', 1]);
    // Nothing a second drain could resend: every intent is claimed.
    expect(await run(b!, [])).toEqual(['duplicate', 0]);
  });

  it('never fails the drain or the form, whatever the provider does', async () => {
    const analytics = new RecordingAnalytics(['throw']);
    expect(await submit({ email: ADDRESS, consent: true })).toMatchObject({ status: 'accepted' });
    expect(analytics.sent).toEqual([]); // The form answered before anything was sent.
    await expect(uow.drain([analyticsSubscriber(deps(analytics))])).resolves.toBe(2);
    expect(analytics.sent).toHaveLength(1);
    const line = log.lines.find((l) => l.message === 'analytics.delivery');
    expect(line).toMatchObject({ level: 'warn', fields: { result: 'unknown' } });
    expect(JSON.stringify(log.lines)).not.toContain('socket hang up');
  });

  it('drops an intent that is too old, malformed or a reserved event', async () => {
    await submit({ email: ADDRESS, consent: true });
    const [intent] = intents();
    const analytics = new RecordingAnalytics();
    const forged = (props: Record<string, unknown>) => ({
      ...intent!,
      id: `${intent!.id}-x`,
      props,
    });
    expect(
      await deliverAnalyticsIntent(
        deps(analytics),
        forged({ name: 'donation.paid', props: { amount: 2500 } })
      )
    ).toBe('malformed');
    expect(
      await deliverAnalyticsIntent(
        deps(analytics),
        forged({ name: 'form.submitted', props: { kind: 'signup', email: ADDRESS } })
      )
    ).toBe('malformed');
    clock.advance(ANALYTICS_DELIVERY_WINDOW_MS + 1);
    expect(await deliverAnalyticsIntent(deps(analytics), intent!)).toBe('expired');
    expect(analytics.sent).toEqual([]);
  });
});
