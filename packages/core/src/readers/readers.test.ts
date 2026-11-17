// Reader sign-in in memory (ADR 016 rule 1, ADR 019): one answer for every request, one mail per
// address per day, a link that works once, a session bound to one tenant that sign-out and
// erasure end, and a reader principal that can only read. The Postgres side (two processes, the
// one winner of a parallel consume, RLS) is packages/db/src/supporters/readers.test.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import { issueProofChallenge } from '../forms/proof.js';
import { issueStartedToken } from '../forms/spam.js';
import { Invoker } from '../invoke.js';
import { sendOnce } from '../mailing/send-attempts.js';
import { issueSession, readSession } from '../operators/session.js';
import type { MailMessage, Mailer } from '../mailing/ports.js';
import {
  READER_CAPABILITIES,
  anonymousPrincipal,
  readerPrincipal,
  systemPrincipal,
  type Principal,
} from '../principal.js';
import {
  FakeClock,
  MemoryMailer,
  MemoryTenants,
  MemoryUnitOfWork,
  principal,
  probeTenant,
  solveProof,
  TENANT,
} from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { SIGNIN_MAIL_SUBSCRIBER, signinMailSource, signinMailSubscriber } from './mail.js';
import {
  READER_SESSION_TTL_MS,
  SIGNIN_FORM_SCOPE,
  SIGNIN_LINK_TTL_MS,
  SIGNIN_REQUESTED,
  safeReturnPath,
  sessionToken,
  signinToken,
} from './model.js';

const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('reader sign-in', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let mailer: MemoryMailer;
  let deps: Parameters<typeof signinMailSubscriber>[0];

  const visitor = (tenant = TENANT, ip = 'ip') => anonymousPrincipal(tenant, ['content:read'], ip);
  const admin = (tenant = TENANT) => systemPrincipal(tenant, 'test');

  /** What the public form posts: empty honeypot and a timing token old enough to be a person. */
  async function spam(proof = false) {
    const startedToken = await issueStartedToken(uow.signer, SIGNIN_FORM_SCOPE, clock.now());
    const solved = proof
      ? await solveProof(await issueProofChallenge(uow.signer, SIGNIN_FORM_SCOPE, clock.now(), 50))
      : undefined;
    clock.advance(5000);
    return { honeypot: '', startedToken, ...(solved ? { proof: solved } : {}) };
  }

  async function request(
    email: string,
    over: { principal?: Principal; returnPath?: string; spam?: object | null } = {}
  ) {
    const fields = over.spam === null ? {} : { spam: over.spam ?? (await spam()) };
    return invoker.run(useCases.requestSignin, over.principal ?? visitor(), {
      email,
      locale: 'nl',
      ...(over.returnPath ? { returnPath: over.returnPath } : {}),
      ...fields,
    });
  }

  const deliver = () => uow.drain([signinMailSubscriber(deps)]);
  const tokenOf = (message: MailMessage | undefined) => {
    const url = message?.text.split('\n').find((line) => line.startsWith('http'));
    return new URL(url ?? 'http://none').searchParams.get('token') ?? '';
  };
  /** Request, deliver and return the token from the mail. */
  async function mailedToken(email: string, over: Parameters<typeof request>[1] = {}) {
    await request(email, over);
    await deliver();
    return tokenOf(mailer.sent.at(-1));
  }
  const complete = (token: string, p: Principal = visitor()) =>
    invoker.run(useCases.completeSignin, p, { token });
  const sessionOf = async (token: string, p: Principal = visitor()) =>
    (await invoker.run(useCases.getReaderSession, p, { token })).session;
  const supporter = (email: string, tenant = TENANT) =>
    uow.run(admin(tenant), (ctx) => ctx.supporters.getProjection(email));

  async function signedIn(email = 'ada@example.org') {
    const done = await complete(await mailedToken(email));
    if (done.status !== 'signed_in') throw new Error(done.status);
    return done;
  }

  beforeEach(() => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
    mailer = new MemoryMailer();
    for (const id of [TENANT, OTHER])
      uow.store.addPlatformHostname(
        { ...probeTenant(id), slug: id === TENANT ? 'probe' : 'other' },
        uow.platform.domain
      );
    deps = {
      mailer,
      signer: uow.signer,
      clock,
      tenants: new MemoryTenants([
        probeTenant(TENANT),
        { ...probeTenant(OTHER), slug: 'other', name: 'Other' },
      ]),
      uow,
      from: { email: 'noreply@example.org' },
      platform: uow.platform,
    };
  });

  describe('reader.signin.request', () => {
    it('answers the same for a known and an unknown address and makes no supporter', async () => {
      await signedIn('known@example.org');
      clock.advance(25 * HOUR);
      const known = await request('known@example.org');
      const unknown = await request('unknown@example.org');
      expect(known).toEqual({ status: 'accepted' });
      expect(unknown).toEqual(known);
      // Asking is not proving: the unknown address is a link row, not a supporter.
      expect(await supporter('unknown@example.org')).toBeNull();
      expect(uow.store.for(TENANT).signinLinks.size).toBe(3);
    });

    it('keeps the address and the token out of the outbox and the job payloads', async () => {
      await request('ada@example.org');
      const [event] = uow.store.outbox;
      expect(event).toMatchObject({ type: SIGNIN_REQUESTED, actor: { kind: 'anonymous' } });
      expect(Object.keys(event!.props)).toEqual(['linkId']);
      await deliver();
      const token = tokenOf(mailer.sent[0]);
      expect(token).not.toBe('');
      const elsewhere = JSON.stringify([uow.store.outbox, uow.store.jobs, event]);
      expect(elsewhere).not.toContain('ada@example.org');
      expect(elsewhere).not.toContain(token);
      // The row keeps a hash, never the token.
      const [link] = uow.store.for(TENANT).signinLinks.values();
      expect(link?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(link)).not.toContain(token);
    });

    it('mails once for five requests to one address, and again a day later', async () => {
      for (let i = 0; i < 5; i++)
        expect(await request('ada@example.org')).toEqual({ status: 'accepted' });
      await deliver();
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]).toMatchObject({
        to: { email: 'ada@example.org' },
        stream: 'transactional',
        subject: 'Je inloglink voor Probe',
      });
      expect(mailer.sent[0]?.headers).toBeUndefined();
      clock.advance(24 * HOUR);
      await request('ada@example.org');
      await deliver();
      expect(mailer.sent).toHaveLength(2);
    });

    it('gives a post without the bot fields the same answer and no mail', async () => {
      expect(await request('ada@example.org', { spam: null })).toEqual({ status: 'accepted' });
      expect(await request('ada@example.org', { spam: { honeypot: 'x' } })).toEqual({
        status: 'accepted',
      });
      // Too fast: a timing token from this very moment.
      const startedToken = await issueStartedToken(uow.signer, SIGNIN_FORM_SCOPE, clock.now());
      expect(await request('ada@example.org', { spam: { honeypot: '', startedToken } })).toEqual({
        status: 'accepted',
      });
      // A timing token issued for a form is not one for the sign-in.
      const foreign = await issueStartedToken(uow.signer, 'some-form', clock.now());
      clock.advance(5000);
      expect(
        await request('ada@example.org', { spam: { honeypot: '', startedToken: foreign } })
      ).toEqual({ status: 'accepted' });
      await deliver();
      expect(mailer.sent).toHaveLength(0);
      expect(uow.store.for(TENANT).signinLinks.size).toBe(0);
      // None of those closed the address for its owner.
      await request('ada@example.org');
      await deliver();
      expect(mailer.sent).toHaveLength(1);
    });

    it('limits one client over many addresses, and a solved proof once', async () => {
      // Without a proof: three an hour per client address.
      for (let i = 0; i < 5; i++) await request(`reader${i}@example.org`);
      await deliver();
      expect(mailer.sent).toHaveLength(3);
      // Another client is not held back by the first.
      await request('other@example.org', { principal: visitor(TENANT, 'ip2') });
      await deliver();
      expect(mailer.sent).toHaveLength(4);
      // A proof lifts the stricter bucket, once per solution.
      const solved = await spam(true);
      await request('proof1@example.org', { spam: solved });
      await request('proof2@example.org', { spam: solved });
      await deliver();
      expect(mailer.sent).toHaveLength(5);
    });

    it('drops a return path that is not a path on this site', async () => {
      expect(safeReturnPath('/nieuws/stuk?x=1')).toBe('/nieuws/stuk?x=1');
      for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'nieuws', ''])
        expect(safeReturnPath(bad)).toBeNull();
      const done = await complete(
        await mailedToken('ada@example.org', { returnPath: '//evil.example/x' })
      );
      expect(done).toMatchObject({ status: 'signed_in', returnPath: null });
    });

    it('is not a use case for an API key, an agent or an operator', async () => {
      const input = { email: 'ada@example.org', locale: 'nl' };
      for (const actor of [
        { kind: 'api-key', keyId: 'k' },
        { kind: 'agent', sessionId: 's', keyId: 'k' },
        { kind: 'operator', operatorId: '01900000-0000-7000-8000-000000000001' },
      ] as const) {
        const caller = principal({ actor, capabilities: ['tenant:admin'] });
        await expect(invoker.run(useCases.requestSignin, caller, input)).rejects.toMatchObject({
          code: 'forbidden',
        });
        await expect(
          invoker.run(useCases.completeSignin, caller, { token: 'x' })
        ).rejects.toMatchObject({ code: 'forbidden' });
        await expect(
          invoker.run(useCases.getReaderSession, caller, { token: 'x' })
        ).rejects.toMatchObject({ code: 'forbidden' });
      }
    });
  });

  describe('the sign-in mail', () => {
    it('links to the primary hostname of the tenant and rebuilds the same link', async () => {
      await request('ada@example.org');
      const [event] = uow.store.outbox;
      const source = signinMailSource(deps);
      const first = await source(event!);
      const again = await source(event!);
      expect(first?.text).toContain('http://localhost:5173/probe/reader/signin?token=');
      expect(again).toEqual(first);
      expect(first?.html).toContain('lang="nl"');
    });

    it('dries up when the link is used, expired or gone', async () => {
      await request('ada@example.org');
      const [event] = uow.store.outbox;
      const source = signinMailSource(deps);
      const token = tokenOf((await source(event!)) ?? undefined);
      expect((await complete(token)).status).toBe('signed_in');
      expect(await source(event!)).toBeNull();

      clock.advance(25 * HOUR);
      await request('ada@example.org');
      const second = uow.store.outbox.at(-1)!;
      clock.advance(SIGNIN_LINK_TTL_MS);
      expect(await source(second)).toBeNull();
      uow.store.for(TENANT).signinLinks.clear();
      expect(await source(second)).toBeNull();
    });

    it('does not send a second mail after a provider time-out', async () => {
      const failing: Mailer = {
        send: async () => {
          throw new Error('timeout talking to reader ada@example.org');
        },
        lookup: async () => null,
      };
      await request('ada@example.org');
      const [event] = uow.store.outbox;
      const message = (await signinMailSource(deps)(event!))!;
      expect(
        await sendOnce({ ...deps, mailer: failing }, event!, SIGNIN_MAIL_SUBSCRIBER, message)
      ).toBe('unknown');
      // The outbox delivers again and the job looks again: the intent is unknown, so nothing
      // goes out, and the intent row holds no address.
      clock.advance(MINUTE);
      await deliver();
      expect(mailer.sent).toHaveLength(0);
      const [intent] = uow.store.for(TENANT).mailSends.values();
      expect(intent).toMatchObject({ sentAt: null, attempts: 1 });
      expect(JSON.stringify(intent)).not.toContain('ada@example.org');
      // The reconcile job was planned with the claim and names the event, not the person.
      expect(uow.store.jobs.map((j) => j.type)).toEqual(['mail.reconcile']);
      expect(JSON.stringify(uow.store.jobs)).not.toContain('ada@');
    });
  });

  describe('reader.signin.complete', () => {
    it('makes the supporter, records reader.signed_in once and opens a session', async () => {
      const token = await mailedToken('ada@example.org', { returnPath: '/nieuws' });
      expect(await supporter('ada@example.org')).toBeNull();
      const done = await complete(token);
      expect(done).toMatchObject({ status: 'signed_in', returnPath: '/nieuws', locale: 'nl' });
      if (done.status !== 'signed_in') throw new Error();
      expect(Date.parse(done.expiresAt) - clock.now().getTime()).toBe(READER_SESSION_TTL_MS);
      const projection = await supporter('ada@example.org');
      expect(projection).toMatchObject({ email: 'ada@example.org', lists: [], grants: [] });
      const events = await uow.run(admin(), (ctx) => ctx.supporters.eventsFor(projection!.id));
      expect(events.map((e) => e.type)).toEqual(['reader.signed_in']);
      expect(events[0]?.props).toEqual({});
      // The cookie value names the session, not the person.
      expect(done.sessionToken).not.toContain('ada@example.org');
      expect(done.sessionToken).not.toContain(projection!.id);
      expect(await sessionOf(done.sessionToken)).toMatchObject({
        sessionId: expect.any(String),
        expiresAt: done.expiresAt,
      });
    });

    it('signs an existing supporter in under the same id and grants no list', async () => {
      const first = await signedIn();
      const before = await supporter('ada@example.org');
      clock.advance(25 * HOUR);
      const second = await signedIn();
      const after = await supporter('ada@example.org');
      expect(after?.id).toBe(before?.id);
      expect(after?.lists).toEqual([]);
      expect(second.sessionToken).not.toBe(first.sessionToken);
      expect(uow.store.for(TENANT).projections.size).toBe(1);
    });

    it('works once: a replay, also at the same moment, is invalid', async () => {
      const token = await mailedToken('ada@example.org');
      const [a, b] = await Promise.all([complete(token), complete(token)]);
      expect([a.status, b.status].sort()).toEqual(['invalid', 'signed_in']);
      expect(await complete(token)).toEqual({ status: 'invalid' });
      expect(uow.store.for(TENANT).readerSessions.size).toBe(1);
    });

    it('refuses an expired, forged or re-signed link with one answer', async () => {
      const token = await mailedToken('ada@example.org');
      const [link] = uow.store.for(TENANT).signinLinks.values();
      // A token someone signed themselves for the same row but a later end: the hash differs.
      const stretched = await signinToken(uow.signer, TENANT, {
        id: link!.id,
        expiresAt: new Date(link!.expiresAt.getTime() + HOUR),
      });
      expect(await complete(stretched)).toEqual({ status: 'invalid' });
      expect(await complete(`${token}x`)).toEqual({ status: 'invalid' });
      expect(await complete('not-a-signed-token')).toEqual({ status: 'invalid' });
      clock.advance(SIGNIN_LINK_TTL_MS);
      expect(await complete(token)).toEqual({ status: 'invalid' });
      expect(await supporter('ada@example.org')).toBeNull();
      expect(uow.store.for(TENANT).readerSessions.size).toBe(0);
    });

    it('does not carry a link or a session to another tenant', async () => {
      const token = await mailedToken('ada@example.org');
      expect(await complete(token, visitor(OTHER))).toEqual({ status: 'invalid' });
      // Still good where it was issued.
      const done = await complete(token);
      if (done.status !== 'signed_in') throw new Error(done.status);
      expect(await sessionOf(done.sessionToken, visitor(OTHER))).toBeNull();
      expect(await sessionOf(done.sessionToken)).not.toBeNull();
      expect(await supporter('ada@example.org', OTHER)).toBeNull();
      // A cookie signed for the other tenant with this session id names nothing there either.
      const [session] = uow.store.for(TENANT).readerSessions.values();
      const forged = await sessionToken(uow.signer, OTHER, session!);
      expect(await sessionOf(forged, visitor(OTHER))).toBeNull();
      expect(await sessionOf(forged)).toBeNull();
    });

    it('counts a first sign-in against the supporter cap', async () => {
      const token = await mailedToken('ada@example.org');
      const full = {
        ...visitor(),
        entitlements: { ...visitor().entitlements, 'supporters.max': 0 },
      };
      await expect(complete(token, full)).rejects.toMatchObject({ code: 'limit_exceeded' });
    });
  });

  describe('the session', () => {
    it('ends at its fixed time and on sign-out, and only for that session', async () => {
      const one = await signedIn();
      clock.advance(25 * HOUR);
      const two = await signedIn();
      // The first is twenty-five hours old: over.
      expect(await sessionOf(one.sessionToken)).toBeNull();
      const three = await signedIn('grace@example.org');
      const session = (await sessionOf(two.sessionToken))!;
      const out = await invoker.run(
        useCases.signoutReader,
        readerPrincipal(TENANT, session.sessionId),
        {}
      );
      expect(out).toEqual({ status: 'signed_out' });
      expect(await sessionOf(two.sessionToken)).toBeNull();
      expect(await sessionOf(three.sessionToken)).not.toBeNull();
      clock.advance(READER_SESSION_TTL_MS);
      expect(await sessionOf(three.sessionToken)).toBeNull();
    });

    it('ends when the supporter is erased, and the address gets no new link', async () => {
      const done = await signedIn();
      const projection = (await supporter('ada@example.org'))!;
      await invoker.run(useCases.eraseSupporter, admin(), { supporterId: projection.id });
      // Registered but not yet applied: the session is already nobody's.
      expect(await sessionOf(done.sessionToken)).toBeNull();
      await uow.run(admin(), (ctx) => ctx.erasures.apply());
      expect(uow.store.for(TENANT).readerSessions.size).toBe(0);
      expect(uow.store.for(TENANT).signinLinks.size).toBe(0);
      expect(uow.store.for(TENANT).mailSends.size).toBe(0);
      expect(await sessionOf(done.sessionToken)).toBeNull();

      clock.advance(25 * HOUR);
      expect(await request('ada@example.org')).toEqual({ status: 'accepted' });
      await deliver();
      expect(mailer.sent).toHaveLength(1);
      expect(uow.store.for(TENANT).signinLinks.size).toBe(0);
    });

    it('erases a pending link with its mail intent and reconcile job', async () => {
      await signedIn();
      const projection = (await supporter('ada@example.org'))!;
      clock.advance(25 * HOUR);
      await request('ada@example.org');
      await deliver();
      expect(uow.store.for(TENANT).signinLinks.size).toBe(2);
      await invoker.run(useCases.eraseSupporter, admin(), { supporterId: projection.id });
      await uow.run(admin(), (ctx) => ctx.erasures.apply());
      const s = uow.store.for(TENANT);
      expect(s.signinLinks.size).toBe(0);
      expect(s.mailSends.size).toBe(0);
      expect(uow.store.jobs.filter((j) => j.type === 'mail.reconcile')).toEqual([]);
    });
  });

  describe('the reader principal', () => {
    it('holds reading and nothing else, whatever the caller would like', async () => {
      const reader = readerPrincipal(TENANT, '01900000-0000-7000-8000-00000000cccc');
      expect(reader.capabilities).toEqual([...READER_CAPABILITIES]);
      expect(reader.capabilities).toEqual(['content:read', 'media:read']);
      const registry = buildRegistry();
      const open = registry
        .list()
        .filter((u) => registry.authorize(u, reader))
        .map((u) => u.name);
      // Everything a reader reaches is public reading, their own sign-in or their own sign-out.
      expect(open).toContain('reader.signout');
      expect(open).toContain('content.published.get');
      for (const name of open) expect(name).toMatch(/^(content|media|reader|campaign|site)\./);
      // Even a reader cookie that somehow carried more opens nothing more.
      const greedy = { ...reader, capabilities: ['tenant:admin' as const] };
      for (const name of ['content.item.create', 'supporter.get', 'tenant.member.invite']) {
        const useCase = registry.get(name)!;
        expect(registry.authorize(useCase, greedy)).toBe(false);
      }
    });

    it('is not an operator session, and an operator session is not a reader', async () => {
      const done = await signedIn();
      // The same Signer signs both; `typ` keeps them apart in both directions.
      expect(await readSession(uow.signer, clock, done.sessionToken)).toBeNull();
      const operator = await issueSession(uow.signer, clock, {
        id: '01900000-0000-7000-8000-000000000001',
        email: 'op@example.org',
        name: null,
      });
      expect(await sessionOf(operator.token)).toBeNull();
      expect(await complete(operator.token)).toEqual({ status: 'invalid' });
      // Nor is a sign-in link a session, or a session a link.
      await request('grace@example.org');
      await deliver();
      expect(await sessionOf(tokenOf(mailer.sent.at(-1)))).toBeNull();
      expect(await complete(done.sessionToken)).toEqual({ status: 'invalid' });
    });

    it('is the only actor that signs out', async () => {
      await expect(invoker.run(useCases.signoutReader, visitor(), {})).rejects.toMatchObject({
        code: 'forbidden',
      });
    });
  });
});
