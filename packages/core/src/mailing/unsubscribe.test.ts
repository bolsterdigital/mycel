// `mailing.opt_out.*` (ADR 010 rule 8) and the link and headers a bulk message carries (RFC 8058),
// in memory. The page and the provider's POST against the real stack: e2e/signup.spec.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal, systemPrincipal } from '../principal.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { FakeClock, MemoryUnitOfWork, TENANT } from '../testing/index.js';
import { ingest } from '../supporters/service.js';
import { SupporterEvent } from '../supporters/events.js';
import { tombstoneEmail } from '../supporters/erasure.js';
import { signConfirmToken } from './confirmation.js';
import {
  ONE_CLICK_VALUE,
  UNSUBSCRIBE_TTL_MS,
  signUnsubscribeToken,
  unsubscribeLink,
  verifyUnsubscribeToken,
} from './unsubscribe.js';

const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const GONE = '01900000-0000-7000-8000-0000000000ff';

describe('mailing.opt_out', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let supporterId: string;

  const system = systemPrincipal(TENANT, 'test');
  const visitor = (tenant = TENANT) => anonymousPrincipal(tenant, ['supporters:write'], 'ip');
  const token = (fields: Partial<{ tenantId: string; supporterId: string; list: string }> = {}) =>
    signUnsubscribeToken(
      uow.signer,
      { tenantId: TENANT, supporterId, list: 'newsletter', locale: 'en', ...fields },
      clock.now()
    );
  const confirm = (t: string, principal = visitor()) =>
    invoker.run(useCases.confirmOptOut, principal, { token: t });
  const preview = (t: string, principal = visitor()) =>
    invoker.run(useCases.previewOptOut, principal, { token: t });
  const projection = () => uow.run(system, (ctx) => ctx.supporters.getProjectionById(supporterId));
  const log = () => uow.run(system, (ctx) => ctx.supporters.eventsFor(supporterId));
  const subscribe = (email: string, list: string, n: number) =>
    uow.run(system, (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: `sub-${list}-${n}`,
          type: 'newsletter.subscribed',
          email,
          occurred_at: new Date(clock.now().getTime() - 60_000 + n).toISOString(),
          source: 'test',
          source_site: 'urn:test',
          source_ref: `test:${n}`,
          props: { list, confirmed: true },
        })
      )
    );

  beforeEach(async () => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
    await subscribe('ada@example.org', 'newsletter', 1);
    await subscribe('ada@example.org', 'events', 2);
    supporterId = (await uow.run(system, (ctx) => ctx.supporters.getProjection('ada@example.org')))!
      .id;
  });

  it('unsubscribes from the one list at once, and a second click writes nothing', async () => {
    const t = await token();
    expect(await preview(t)).toEqual({ status: 'subscribed', locale: 'en' });
    expect(await confirm(t)).toEqual({ status: 'unsubscribed', locale: 'en' });
    // In the same transaction: the next send reads the projection without the list.
    expect(await projection()).toMatchObject({ lists: ['events'], pendingLists: [] });
    const withdrawals = (await log()).filter((e) => e.type === 'newsletter.unsubscribed');
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0]).toMatchObject({
      email: 'ada@example.org',
      source: 'mycel',
      props: { list: 'newsletter', via: 'page' },
    });

    clock.advance(1000);
    expect(await preview(t)).toEqual({ status: 'already_unsubscribed', locale: 'en' });
    expect(
      await invoker.run(useCases.confirmOptOut, visitor(), { token: t, via: 'one_click' })
    ).toEqual({ status: 'already_unsubscribed', locale: 'en' });
    expect((await log()).filter((e) => e.type === 'newsletter.unsubscribed')).toHaveLength(1);
  });

  it('treats a forged, expired, foreign or other-purpose token as invalid, without a write', async () => {
    const before = await projection();
    const both = async (t: string, principal = visitor()) => {
      expect(await preview(t, principal)).toEqual({ status: 'invalid' });
      expect(await confirm(t, principal)).toEqual({ status: 'invalid' });
    };
    await both('forged');
    const t = await token();
    clock.advance(UNSUBSCRIBE_TTL_MS + 1);
    await both(t);
    clock.current = new FakeClock().now();
    // A link for this tenant followed on another tenant's site, and the other way round.
    await both(await token(), visitor(OTHER));
    await both(await token({ tenantId: OTHER }));
    await both(await token({ supporterId: GONE }));
    // A double opt-in token is signed with the same key and must not pass as an unsubscribe.
    await both(
      await signConfirmToken(
        uow.signer,
        { tenantId: TENANT, submissionId: supporterId, list: 'newsletter' },
        clock.now()
      )
    );
    expect(await projection()).toEqual(before);
  });

  it('follows the supporter across an address change, and an erased one is invalid', async () => {
    const t = await token();
    await invoker.run(useCases.changeSupporterEmail, system, {
      supporterId,
      newEmail: 'ada@new.example',
      reason: 'test',
    });
    expect(await confirm(t)).toEqual({ status: 'unsubscribed', locale: 'en' });
    expect(await projection()).toMatchObject({ email: 'ada@new.example', lists: ['events'] });

    const events = await token({ list: 'events' });
    await uow.run(system, async (ctx) => {
      const p = (await ctx.supporters.getProjectionById(supporterId))!;
      await ctx.supporters.saveProjection({ ...p, email: tombstoneEmail(p.id) });
    });
    expect(await preview(events)).toEqual({ status: 'invalid' });
    expect(await confirm(events)).toEqual({ status: 'invalid' });
  });

  it('makes the link and the RFC 8058 headers of one recipient, on the primary hostname', async () => {
    const deps = {
      signer: uow.signer,
      clock,
      platform: { platformOrigin: 'https://mycel.example', siteUrlMode: 'hostnames' as const },
    };
    const input = {
      tenant: { id: TENANT, slug: 'probe' },
      primaryHostname: 'news.example.org',
      supporterId,
      list: 'newsletter',
      locale: 'nl',
    };
    const link = await unsubscribeLink(deps, input);
    expect(link.url).toMatch(/^https:\/\/news\.example\.org\/unsubscribe\?token=[^&]+$/);
    expect(link.oneClickUrl).toMatch(
      /^https:\/\/news\.example\.org\/unsubscribe\/one-click\?token=[^&]+$/
    );
    expect(link.headers).toEqual({
      'List-Unsubscribe': `<${link.oneClickUrl}>`,
      'List-Unsubscribe-Post': ONE_CLICK_VALUE,
    });
    const signed = new URL(link.oneClickUrl).searchParams.get('token')!;
    expect(await verifyUnsubscribeToken(uow.signer, signed, clock.now())).toMatchObject({
      kind: 'unsubscribe',
      tenantId: TENANT,
      supporterId,
      list: 'newsletter',
      locale: 'nl',
    });
    // Without a hostname of its own the site lives under its slug on the platform origin.
    const path = await unsubscribeLink(deps, { ...input, primaryHostname: null });
    expect(path.url).toMatch(/^https:\/\/mycel\.example\/probe\/unsubscribe\?token=/);
  });
});
