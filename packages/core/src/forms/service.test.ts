// Forms in memory: `form.get` and `form.submit` (ADR 010, brief form-intake, checklist
// `formulieren-en-mail`). Field validation, the spam defence in its order (honeypot, timing
// token, proof of work, per-IP and per-recipient limits), what a refusal logs and that it writes
// nothing. The signup's way through outbox, projection and confirmation mail is the vertical
// probe in `probe.test.ts`; the Postgres side of the limits is in the db conformance suites.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal, systemPrincipal, type Principal } from '../principal.js';
import {
  FakeClock,
  MemoryLogger,
  MemoryUnitOfWork,
  probeForm,
  solveProof,
} from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { issueProofChallenge, type ProofChallenge } from './proof.js';
import { validateValues } from './service.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const FORM = '01900000-0000-7000-8000-00000000f000';
const MISSING = '01900000-0000-7000-8000-00000000dead';

describe('validateValues', () => {
  const { fields } = probeForm(FORM);

  it('trims and lowercases the address and reads a checkbox from HTML or JSON', () => {
    expect(validateValues(fields, { email: ' Ada@Example.org ', consent: 'on' })).toEqual({
      values: { email: 'ada@example.org', consent: true },
      email: 'ada@example.org',
      errors: [],
    });
    expect(validateValues(fields, { email: 'a@example.org', consent: true }).errors).toEqual([]);
  });

  it('treats an absent, empty or "false" checkbox as no consent', () => {
    for (const consent of [undefined, '', 'false', false]) {
      const raw = { email: 'a@example.org', ...(consent !== undefined && { consent }) };
      expect(validateValues(fields, raw).errors, String(consent)).toEqual([
        { field: 'consent', message: 'forms.error.consent.required' },
      ]);
    }
  });

  it('requires a required address, skips an optional empty one, and ignores unknown fields', () => {
    expect(validateValues(fields, { email: '  ', consent: 'on' }).errors).toEqual([
      { field: 'email', message: 'forms.error.required' },
    ]);
    const optional = fields.map((f) => (f.type === 'email' ? { ...f, required: false } : f));
    expect(validateValues(optional, { consent: 'on', extra: 'x' })).toEqual({
      values: { consent: true },
      email: '',
      errors: [],
    });
  });
});

describe('form use cases', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let admin: Principal;
  let log: MemoryLogger;

  beforeEach(async () => {
    clock = new FakeClock();
    log = new MemoryLogger();
    uow = new MemoryUnitOfWork({ clock, log });
    invoker = new Invoker(buildRegistry(), uow);
    admin = systemPrincipal(TENANT, 'test');
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(FORM)));
  });

  const reader = () => anonymousPrincipal(TENANT, ['content:read', 'forms:read']);
  const visitor = (ip = 'ip-1') => anonymousPrincipal(TENANT, ['forms:write'], ip);

  async function startedToken(form = FORM): Promise<string> {
    const { startedToken } = await invoker.run(useCases.getForm, reader(), { id: form });
    return startedToken;
  }

  /**
   * A valid proof without the real search: a challenge signed by the same signer over a tiny
   * space. The handler trusts its own signature, not `maxNumber`, so this is what a browser
   * would post; the real search space is covered once, in the D2 test below.
   */
  async function cheapProof(form = FORM): Promise<string> {
    const challenge = await uow.run(admin, (ctx) =>
      issueProofChallenge(ctx.signer, form, clock.now(), 20)
    );
    return solveProof(challenge);
  }

  async function submit(
    values: Record<string, string | boolean>,
    opts: {
      wait?: number;
      ip?: string;
      honeypot?: string | null;
      form?: string;
      /** `null` posts no proof (a browser without JavaScript). */
      proof?: string | null;
    } = {}
  ) {
    const token = await startedToken(opts.form);
    const proof = opts.proof === undefined ? await cheapProof(opts.form) : opts.proof;
    clock.advance(opts.wait ?? 4000);
    return invoker.run(useCases.submitForm, visitor(opts.ip), {
      formId: opts.form ?? FORM,
      values,
      locale: 'en',
      pageUrl: 'https://example.org/probe/signup',
      spam: {
        startedToken: token,
        ...(opts.honeypot !== null && { honeypot: opts.honeypot ?? '' }),
        ...(proof !== null && { proof }),
      },
    });
  }

  /** The reasons of the `form.submit.rejected` lines so far, and that no line names more. */
  const rejections = () =>
    log.lines
      .filter((l) => l.message === 'form.submit.rejected')
      .map((l) => {
        expect(Object.keys(l.fields).sort()).toEqual(['formId', 'reason']);
        return l.fields['reason'];
      });

  it('returns field errors as i18n keys', async () => {
    const result = await submit({ email: 'not-an-address' });
    expect(result).toEqual({
      status: 'invalid',
      errors: [
        { field: 'email', message: 'forms.error.email.invalid' },
        { field: 'consent', message: 'forms.error.consent.required' },
      ],
    });
    expect(uow.store.outbox).toHaveLength(0);
  });

  it('rejects the honeypot, a missing or forged timing token, and fast submissions', async () => {
    expect(
      await submit({ email: 'a@example.org', consent: 'on' }, { honeypot: 'http://spam' })
    ).toMatchObject({ status: 'rejected', reason: 'spam' });
    expect(await submit({ email: 'a@example.org', consent: 'on' }, { wait: 1000 })).toMatchObject({
      status: 'rejected',
      reason: 'too-fast',
    });
    const forged = await invoker.run(useCases.submitForm, visitor(), {
      formId: FORM,
      values: { email: 'a@example.org', consent: 'on' },
      locale: 'en',
      spam: { startedToken: '{"f":"x","t":0}~forged', honeypot: '' },
    });
    expect(forged).toMatchObject({ status: 'rejected', reason: 'spam' });
    expect(uow.store.outbox).toHaveLength(0);
    expect(rejections()).toEqual(['honeypot', 'too-fast', 'token-invalid']);
  });

  it('rate-limits per IP, visibly', async () => {
    for (let i = 0; i < 10; i++)
      await submit({ email: `p${i}@example.org`, consent: 'on' }, { ip: 'busy' });
    expect(
      await submit({ email: 'fresh@example.org', consent: 'on' }, { ip: 'busy' })
    ).toMatchObject({ reason: 'rate-limited', message: 'forms.rejected.rate-limited' });
    expect(rejections()).toEqual(['ip-limited']);
  });

  // Brief form-intake § 1 and § 6 (a): one confirmation per address per form per 24 hours.
  it('sends one confirmation per address per form a day, silently, on a sliding window', async () => {
    const OTHER_FORM = '01900000-0000-7000-8000-00000000f001';
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(OTHER_FORM)));
    const results = [];
    for (let i = 0; i < 5; i++)
      results.push(await submit({ email: 'same@example.org', consent: 'on' }, { ip: `ip-${i}` }));
    expect(results.map((r) => r.status)).toEqual([
      'accepted',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ]);
    expect(results[1]).toEqual({ status: 'rejected', reason: 'recipient-limited', message: '' });
    expect(uow.store.for(TENANT).submissions.size).toBe(1);
    expect(uow.store.outbox.filter((e) => e.type === 'newsletter.subscribed')).toHaveLength(1);
    expect(rejections()).toEqual(Array(4).fill('recipient-limited'));

    // Another form of the same tenant is its own consent scope.
    expect(
      (await submit({ email: 'same@example.org', consent: 'on' }, { form: OTHER_FORM })).status
    ).toBe('accepted');
    // Sliding from the one that went through, not on a day boundary: a second short of a day
    // after it still refused, a second past it one more confirmation. Each `submit` waits 4 s;
    // the first went through 20 s ago.
    const day = 24 * 60 * 60 * 1000;
    clock.advance(day - 20_000 - 4000 - 1000);
    expect((await submit({ email: 'same@example.org', consent: 'on' })).status).toBe('rejected');
    clock.advance(2000 - 4000);
    expect((await submit({ email: 'same@example.org', consent: 'on' })).status).toBe('accepted');
    expect((await submit({ email: 'same@example.org', consent: 'on' })).status).toBe('rejected');
  });

  // § 6 (b): checklist rule 8, a post without the honeypot field is not from our form.
  it('refuses an anonymous post without the honeypot field as spam', async () => {
    expect(await submit({ email: 'a@example.org', consent: 'on' }, { honeypot: null })).toEqual({
      status: 'rejected',
      reason: 'spam',
      message: '',
    });
    expect(uow.store.for(TENANT).submissions.size).toBe(0);
    expect(rejections()).toEqual(['honeypot']);
  });

  // § 6 (c): a failing port is a failure, never an accepted signup or a rejection.
  it('throws when storing the submission fails, and publishes nothing', async () => {
    uow.store.for(TENANT).submissions.set = () => {
      throw new Error('connection terminated');
    };
    await expect(submit({ email: 'a@example.org', consent: 'on' })).rejects.toThrow(
      'connection terminated'
    );
    expect(uow.store.outbox).toHaveLength(0);
  });

  // § 6 (d): the token lives 24 hours; a page rendered afresh gives a fresh one (#30A).
  it('refuses a timing token older than a day and accepts a fresh one', async () => {
    const old = await startedToken();
    clock.advance(24 * 60 * 60 * 1000 + 1000);
    const post = (token: string) =>
      invoker.run(useCases.submitForm, visitor(), {
        formId: FORM,
        values: { email: 'late@example.org', consent: 'on' },
        locale: 'en',
        spam: { startedToken: token, honeypot: '' },
      });
    expect(await post(old)).toMatchObject({ status: 'rejected', reason: 'spam' });
    const fresh = await startedToken();
    clock.advance(4000);
    expect((await post(fresh)).status).toBe('accepted');
    expect(rejections()).toEqual(['token-invalid']);
  });

  it('lets trusted integrations submit without timing token or proof but not past the rate limit', async () => {
    const result = await invoker.run(useCases.submitForm, admin, {
      formId: FORM,
      values: { email: 'api@example.org', consent: true },
      locale: 'nl',
    });
    expect(result.status).toBe('accepted');
    expect(log.lines.map((l) => l.message)).not.toContain('form.submit.unproven');
  });

  // Brief form-intake § D2.4: ALTCHA, with a stricter route instead of a wall without JavaScript.
  describe('proof of work', () => {
    async function challenge(form = FORM): Promise<ProofChallenge> {
      return (await invoker.run(useCases.getForm, reader(), { id: form })).proof;
    }
    const email = (n: number) => ({ email: `w${n}@example.org`, consent: 'on' });

    it('issues a signed challenge with every form and accepts its solution', async () => {
      const c = await challenge();
      expect(c).toMatchObject({ algorithm: 'SHA-256', maxNumber: 100_000 });
      expect(c.challenge).toMatch(/^[0-9a-f]{64}$/);
      expect(await challenge()).not.toEqual(c);
      expect((await submit(email(1), { proof: await solveProof(c) })).status).toBe('accepted');
      expect(rejections()).toEqual([]);
    });

    it('refuses a wrong number, a forged signature, an expired, foreign or reused solution as spam', async () => {
      const OTHER_FORM = '01900000-0000-7000-8000-00000000f001';
      await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(OTHER_FORM)));
      const c = await uow.run(admin, (ctx) =>
        issueProofChallenge(ctx.signer, FORM, clock.now(), 20)
      );
      const right = await solveProof(c);
      const number = (JSON.parse(atob(right)) as { number: number }).number;
      const spam = { status: 'rejected', reason: 'spam', message: '' };

      expect(
        await submit(email(1), { proof: await solveProof(c, { number: number + 1 }) })
      ).toEqual(spam);
      expect(
        await submit(email(2), { proof: await solveProof(c, { signature: `${c.signature}x` }) })
      ).toEqual(spam);
      expect(await submit(email(3), { proof: 'not base64 json' })).toEqual(spam);
      expect(await submit(email(4), { proof: await cheapProof(OTHER_FORM) })).toEqual(spam);

      expect((await submit(email(5), { proof: right })).status).toBe('accepted');
      expect(await submit(email(6), { proof: right })).toEqual(spam);

      const late = await cheapProof();
      clock.advance(24 * 60 * 60 * 1000 + 1000);
      expect(await submit(email(7), { proof: late })).toEqual(spam);

      expect(rejections()).toEqual(Array(6).fill('proof-invalid'));
      expect(uow.store.for(TENANT).submissions.size).toBe(1);
    });

    it('accepts a post without proof on a stricter per-IP bucket, and says so in the log', async () => {
      for (let i = 0; i < 3; i++)
        expect((await submit(email(i), { proof: null, ip: 'nojs' })).status).toBe('accepted');
      expect(await submit(email(3), { proof: null, ip: 'nojs' })).toMatchObject({
        status: 'rejected',
        reason: 'rate-limited',
        message: 'forms.rejected.rate-limited',
      });
      // The same address with a proof is on the ordinary bucket.
      expect((await submit(email(4), { ip: 'nojs' })).status).toBe('accepted');
      expect(log.lines.filter((l) => l.message === 'form.submit.unproven')).toHaveLength(4);
      expect(rejections()).toEqual(['ip-limited']);
      // An hour later the bucket is open again.
      clock.advance(60 * 60 * 1000);
      expect((await submit(email(5), { proof: null, ip: 'nojs' })).status).toBe('accepted');
    });
  });

  it('answers not_found for an unknown form, before any spam check', async () => {
    await expect(invoker.run(useCases.getForm, reader(), { id: MISSING })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      invoker.run(useCases.submitForm, visitor(), {
        formId: MISSING,
        values: {},
        locale: 'en',
      })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(rejections()).toEqual([]);
  });
});
