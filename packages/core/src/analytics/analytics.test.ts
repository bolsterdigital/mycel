// Measurement, first part: the tenant opt-in and the closed contract. The setting is an administrator's,
// per tenant and versioned; the public read returns the identifier alone; the catalogue, the
// delivery shape and the pageview decision refuse everything the brief's privacy contract names.
import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal } from '../principal.js';
import { MemoryUnitOfWork } from '../testing/memory.js';
import { TENANT, principal, probeTenant, hostedPlatform } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import {
  AnalyticsDelivery,
  AnalyticsEvent,
  ANALYTICS_EVENTS,
  PlausibleDomain,
  RESERVED_ANALYTICS_EVENTS,
} from './model.js';
import { isSafeSlug, pageviewDecision, type PageviewRequest } from './eligibility.js';
import { NoopAnalytics } from './ports.js';

const OTHER = '01900000-0000-7000-8000-00000000bb12';

function setup() {
  const uow = new MemoryUnitOfWork({ platform: hostedPlatform });
  uow.store.addPlatformHostname(probeTenant(TENANT), hostedPlatform.domain);
  return { uow, invoker: new Invoker(buildRegistry(), uow) };
}

describe('analytics settings', () => {
  it('is off by default, set and cleared by an administrator, and versioned', async () => {
    const { invoker } = setup();
    const admin = principal();
    expect(await invoker.run(useCases.getAnalyticsSettings, admin, {})).toEqual({
      version: 0,
      value: { plausibleDomain: null },
      primaryHostname: 'probe.mycel.site',
      hostnameMismatch: false,
    });
    expect(
      await invoker.run(useCases.updateAnalyticsSettings, admin, {
        baseVersion: 0,
        settings: { plausibleDomain: ' Probe.Mycel.Site ' },
      })
    ).toEqual({ version: 1, value: { plausibleDomain: 'probe.mycel.site' } });
    await expect(
      invoker.run(useCases.updateAnalyticsSettings, admin, {
        baseVersion: 0,
        settings: { plausibleDomain: 'other.example' },
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      await invoker.run(
        useCases.getAnalyticsTracker,
        anonymousPrincipal(TENANT, ['content:read']),
        {}
      )
    ).toEqual({ plausibleDomain: 'probe.mycel.site' });
    await invoker.run(useCases.updateAnalyticsSettings, admin, {
      baseVersion: 1,
      settings: { plausibleDomain: null },
    });
    expect(
      await invoker.run(
        useCases.getAnalyticsTracker,
        anonymousPrincipal(TENANT, ['content:read']),
        {}
      )
    ).toEqual({ plausibleDomain: null });
  });

  it('shows a mismatch with the primary hostname and never rewrites the setting', async () => {
    const { invoker } = setup();
    const admin = principal();
    await invoker.run(useCases.updateAnalyticsSettings, admin, {
      baseVersion: 0,
      settings: { plausibleDomain: 'old-campaign.example' },
    });
    expect(await invoker.run(useCases.getAnalyticsSettings, admin, {})).toMatchObject({
      value: { plausibleDomain: 'old-campaign.example' },
      primaryHostname: 'probe.mycel.site',
      hostnameMismatch: true,
    });
    await invoker.run(useCases.updateAnalyticsSettings, admin, {
      baseVersion: 1,
      settings: { plausibleDomain: 'www.probe.mycel.site' },
    });
    expect(await invoker.run(useCases.getAnalyticsSettings, admin, {})).toMatchObject({
      hostnameMismatch: false,
    });
  });

  it('refuses identifiers that could be read as a place to fetch from', async () => {
    const { invoker } = setup();
    for (const plausibleDomain of [
      'https://example.org',
      'example.org:8080',
      'example.org/path',
      'example.org?x=1',
      'example.org#x',
      'exa mple.org',
      'user@example.org',
      'localhost',
      '-example.org',
      'example-.org',
      'example..org',
      '',
      `${'a'.repeat(64)}.org`,
      `${'a.'.repeat(127)}org`,
    ]) {
      expect(PlausibleDomain.safeParse(plausibleDomain).success, plausibleDomain).toBe(false);
      await expect(
        invoker.run(useCases.updateAnalyticsSettings, principal(), {
          baseVersion: 0,
          settings: { plausibleDomain },
        }),
        plausibleDomain
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(
      invoker.run(useCases.updateAnalyticsSettings, principal(), {
        baseVersion: 0,
        settings: { plausibleDomain: 'example.org', script: 'https://evil.example/x.js' } as never,
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('is an administrator decision: editors and keys without tenant:admin are refused', async () => {
    const { invoker } = setup();
    for (const capabilities of [
      ['content:read', 'content:write', 'content:publish'],
      ['forms:read', 'supporters:read'],
    ] as const) {
      const p = principal({ capabilities: [...capabilities] });
      await expect(invoker.run(useCases.getAnalyticsSettings, p, {})).rejects.toMatchObject({
        code: 'forbidden',
      });
      await expect(
        invoker.run(useCases.updateAnalyticsSettings, p, {
          baseVersion: 0,
          settings: { plausibleDomain: 'example.org' },
        })
      ).rejects.toMatchObject({ code: 'forbidden' });
    }
    const key = principal({
      actor: { kind: 'api-key', keyId: 'key-1' },
      capabilities: ['tenant:admin'],
    });
    await expect(
      invoker.run(useCases.updateAnalyticsSettings, key, {
        baseVersion: 0,
        settings: { plausibleDomain: 'example.org' },
      })
    ).resolves.toMatchObject({ version: 1 });
  });

  it('keeps tenants apart and records who changed the setting', async () => {
    const { uow, invoker } = setup();
    await invoker.run(useCases.updateAnalyticsSettings, principal(), {
      baseVersion: 0,
      settings: { plausibleDomain: 'probe.example' },
    });
    expect(
      await invoker.run(
        useCases.getAnalyticsTracker,
        anonymousPrincipal(OTHER, ['content:read']),
        {}
      )
    ).toEqual({ plausibleDomain: null });
    expect(
      await invoker.run(useCases.getAnalyticsSettings, principal({ tenantId: OTHER }), {})
    ).toMatchObject({ version: 0, value: { plausibleDomain: null } });
    const rows = uow.store
      .for(TENANT)
      .audit.filter((r) => r.operation === 'analytics.settings.update');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: 'ok', actorKind: 'system' });
    expect(uow.store.for(OTHER).audit).toHaveLength(0);
  });

  it('lets a suspended tenant read but not change the setting', async () => {
    const { invoker } = setup();
    await invoker.run(useCases.updateAnalyticsSettings, principal(), {
      baseVersion: 0,
      settings: { plausibleDomain: 'probe.example' },
    });
    const suspended = principal({ tenantStatus: 'suspended' });
    await expect(
      invoker.run(useCases.updateAnalyticsSettings, suspended, {
        baseVersion: 1,
        settings: { plausibleDomain: null },
      })
    ).rejects.toMatchObject({ code: 'suspended' });
    expect(await invoker.run(useCases.getAnalyticsSettings, suspended, {})).toMatchObject({
      value: { plausibleDomain: 'probe.example' },
    });
  });
});

describe('analytics catalogue and delivery', () => {
  const delivery = {
    domain: 'example.org',
    url: 'https://example.org/',
    event: { name: 'form.submitted', props: { kind: 'signup' } },
  };

  it('delivers only catalogue events with their fixed props', () => {
    expect(Object.keys(ANALYTICS_EVENTS)).toEqual(['form.submitted']);
    expect(AnalyticsEvent.safeParse(delivery.event).success).toBe(true);
    for (const event of [
      { name: 'form.confirmed', props: {} },
      { name: 'donation.paid', props: {} },
      { name: 'form.submitted', props: { kind: 'signup', formId: 'f-1' } },
      { name: 'form.submitted', props: { kind: 'petition' } },
      { name: 'form.submitted', props: { kind: 'signup' }, email: 'a@example.org' },
      { name: 'pageview', props: {} },
    ])
      expect(AnalyticsEvent.safeParse(event).success, JSON.stringify(event)).toBe(false);
    for (const name of RESERVED_ANALYTICS_EVENTS) expect(ANALYTICS_EVENTS).not.toHaveProperty(name);
  });

  it('takes a queryless site root and nothing that names a visitor', () => {
    expect(AnalyticsDelivery.safeParse(delivery).success).toBe(true);
    expect(
      AnalyticsDelivery.safeParse({ ...delivery, url: 'http://localhost:5173/probe' }).success
    ).toBe(true);
    for (const url of [
      'https://example.org/?token=abc',
      'https://example.org/#x',
      'https://example.org/?',
      'https://example.org/confirm/abc',
      'https://user:pw@example.org/',
      'ftp://example.org/',
      'https://example.org/a/b',
    ])
      expect(AnalyticsDelivery.safeParse({ ...delivery, url }).success, url).toBe(false);
    for (const extra of [{ ip: '127.0.0.1' }, { userAgent: 'x' }, { referrer: 'https://a/' }])
      expect(AnalyticsDelivery.safeParse({ ...delivery, ...extra }).success).toBe(false);
  });

  it('defaults to a transport that sends nothing', async () => {
    expect(await new NoopAnalytics().send(AnalyticsDelivery.parse(delivery))).toBe('disabled');
  });
});

describe('pageview decision', () => {
  const page: PageviewRequest = {
    method: 'GET',
    status: 200,
    contentType: 'text/html; charset=utf-8',
    pathname: '/en/articles/hello',
    search: '',
    representation: 'published',
    published: {
      type: 'article',
      slug: 'hello',
      access: 'public',
      locale: 'en',
      defaultLocale: 'nl',
    },
  };

  it('counts a published public page under its canonical, queryless path', () => {
    expect(pageviewDecision(page)).toEqual({
      eligible: true,
      path: '/en/articles/hello',
      aggregated: false,
    });
    expect(
      pageviewDecision({
        ...page,
        pathname: '/probe/articles/hello',
        search: '?utm_source=x',
        published: { ...page.published!, locale: 'nl' },
      })
    ).toEqual({ eligible: true, path: '/articles/hello', aggregated: false });
    expect(
      pageviewDecision({
        ...page,
        published: { ...page.published!, type: 'page', slug: 'index', locale: 'nl' },
      })
    ).toMatchObject({ eligible: true, path: '/' });
    expect(pageviewDecision({ ...page, contentType: null })).toMatchObject({ eligible: true });
  });

  it('refuses everything that is not a successful GET of published public HTML', () => {
    const refused = (change: Partial<PageviewRequest>) => pageviewDecision({ ...page, ...change });
    expect(refused({ method: 'POST' })).toEqual({ eligible: false, reason: 'method' });
    expect(refused({ method: 'HEAD' })).toEqual({ eligible: false, reason: 'method' });
    for (const status of [201, 204, 301, 303, 304, 404, 410, 500])
      expect(refused({ status })).toEqual({ eligible: false, reason: 'status' });
    for (const contentType of [
      'application/json',
      'text/markdown',
      'application/rss+xml',
      'image/webp',
    ])
      expect(refused({ contentType })).toEqual({ eligible: false, reason: 'not-html' });
    for (const representation of [
      'admin',
      'reader',
      'callback',
      'preview',
      'media',
      'api',
      'internal',
      'form-action',
      'error',
      'redirect',
      'other',
    ] as const)
      expect(refused({ representation }), representation).toEqual({
        eligible: false,
        reason: 'representation',
      });
    expect(refused({ published: null })).toEqual({ eligible: false, reason: 'representation' });
    expect(refused({ published: { ...page.published!, access: 'restricted' } })).toEqual({
      eligible: false,
      reason: 'restricted',
    });
  });

  it('refuses confirm routes and any token in the query, whatever the representation says', () => {
    for (const pathname of ['/confirm', '/probe/confirm/abc', '/en/Confirm', '/%63onfirm/x'])
      expect(pageviewDecision({ ...page, pathname }), pathname).toEqual({
        eligible: false,
        reason: 'confirm',
      });
    expect(pageviewDecision({ ...page, pathname: '/%E0%A4%A' })).toEqual({
      eligible: false,
      reason: 'malformed-path',
    });
    for (const search of [
      '?token=abc',
      'token',
      '?a=1&token=',
      '?a=1;Token=x',
      '?access_token=x',
      '?%74oken=x',
      '?TOKEN=1',
    ])
      expect(pageviewDecision({ ...page, search }), search).toEqual({
        eligible: false,
        reason: 'token',
      });
    expect(pageviewDecision({ ...page, search: '?a=%E0%A4%A' })).toEqual({
      eligible: true,
      path: '/en/articles/hello',
      aggregated: false,
    });
    expect(pageviewDecision({ ...page, search: '?%E0%A4%A=1' })).toEqual({
      eligible: false,
      reason: 'malformed-query',
    });
  });

  it('counts a slug shaped like a personal or secret identifier under its content type', () => {
    for (const slug of [
      '0193b0a2-5f1e-7a00-8000-0000000000aa',
      '0193b0a25f1e7a0080000000000000aa',
      'call-0612345678',
      'reset-a8f3k2l9q0w7e6r5t4y3',
    ]) {
      expect(isSafeSlug(slug), slug).toBe(false);
      expect(pageviewDecision({ ...page, published: { ...page.published!, slug } })).toEqual({
        eligible: true,
        path: '/en/articles/-',
        aggregated: true,
      });
    }
    expect(
      pageviewDecision({
        ...page,
        published: { ...page.published!, type: 'page', slug: 'jan@example.org', locale: 'nl' },
      })
    ).toEqual({ eligible: true, path: '/-', aggregated: true });
    for (const slug of ['2026-11-18-nieuws', 'over-ons', 'a', 'verkiezingen-2027'])
      expect(isSafeSlug(slug), slug).toBe(true);
  });
});
