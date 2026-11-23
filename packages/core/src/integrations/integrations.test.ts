// Managed integrations, first part: the closed catalogue, the tenant's switch and the
// pure decision the public page will use. The setting is an administrator's, per tenant and
// versioned; the public read carries switched-on entries only; the decision places nothing outside
// published public HTML, keeps a tag manager off pages where visitors type personal data and adds
// only the origins of what it places.
import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal } from '../principal.js';
import { MemoryUnitOfWork } from '../testing/memory.js';
import { TENANT, principal, hostedPlatform } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import type { PageviewRequest } from '../analytics/eligibility.js';
import {
  DEFAULT_INTEGRATIONS,
  GtmContainerId,
  INTEGRATIONS,
  IntegrationSettings,
  TAG_VENDORS,
  type IntegrationPlacement,
} from './model.js';
import { integrationDecision } from './decision.js';

const OTHER = '01900000-0000-7000-8000-00000000bb41';
const visitor = (tenant = TENANT) => anonymousPrincipal(tenant, ['content:read']);

const GTM_ON = {
  enabled: true,
  containerId: 'GTM-ABC123',
  category: 'marketing' as const,
  vendors: ['meta-pixel' as const],
};

function setup() {
  const uow = new MemoryUnitOfWork({ platform: hostedPlatform });
  return { uow, invoker: new Invoker(buildRegistry(), uow) };
}

describe('integration settings', () => {
  it('is all off by default, switched by an administrator, and versioned', async () => {
    const { invoker } = setup();
    const admin = principal();
    expect(await invoker.run(useCases.getIntegrationSettings, admin, {})).toEqual({
      version: 0,
      value: DEFAULT_INTEGRATIONS,
    });
    expect(await invoker.run(useCases.getIntegrationPlacement, visitor(), {})).toEqual({
      embeds: [],
      tagManager: null,
    });
    const saved = await invoker.run(useCases.updateIntegrationSettings, admin, {
      baseVersion: 0,
      settings: {
        ...DEFAULT_INTEGRATIONS,
        vimeo: { enabled: true },
        'google-tag-manager': { ...GTM_ON, containerId: ' gtm-abc123 ' },
      },
    });
    expect(saved.version).toBe(1);
    expect(saved.value['google-tag-manager'].containerId).toBe('GTM-ABC123');
    await expect(
      invoker.run(useCases.updateIntegrationSettings, admin, {
        baseVersion: 0,
        settings: DEFAULT_INTEGRATIONS,
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await invoker.run(useCases.getIntegrationPlacement, visitor(), {})).toEqual({
      embeds: ['vimeo'],
      tagManager: { containerId: 'GTM-ABC123', category: 'marketing', vendors: ['meta-pixel'] },
    });
    // The kill switch keeps the parameters but places nothing from the next read on.
    await invoker.run(useCases.updateIntegrationSettings, admin, {
      baseVersion: 1,
      settings: {
        ...DEFAULT_INTEGRATIONS,
        'google-tag-manager': { ...GTM_ON, enabled: false },
      },
    });
    expect(await invoker.run(useCases.getIntegrationPlacement, visitor(), {})).toEqual({
      embeds: [],
      tagManager: null,
    });
    expect(
      (await invoker.run(useCases.getIntegrationSettings, admin, {})).value['google-tag-manager']
        .containerId
    ).toBe('GTM-ABC123');
  });

  it('accepts only catalogue entries and validated parameters, never an origin or a script', () => {
    const parse = (patch: Record<string, unknown>) =>
      IntegrationSettings.safeParse({ ...DEFAULT_INTEGRATIONS, ...patch }).success;
    expect(parse({})).toBe(true);
    const { 'bunny-stream': bunny, ...storedBeforeBunny } = DEFAULT_INTEGRATIONS;
    expect(IntegrationSettings.parse(storedBeforeBunny)['bunny-stream']).toEqual(bunny);
    expect(parse({ 'bunny-stream': { enabled: true, src: 'https://example.org/player' } })).toBe(
      false
    );
    expect(parse({ hotjar: { enabled: true } })).toBe(false);
    expect(parse({ youtube: { enabled: true, src: 'https://evil.example/x.js' } })).toBe(false);
    expect(parse({ 'google-tag-manager': { ...GTM_ON, enabled: true, containerId: null } })).toBe(
      false
    );
    expect(parse({ 'google-tag-manager': { ...GTM_ON, vendors: ['hotjar'] } })).toBe(false);
    expect(
      parse({ 'google-tag-manager': { ...GTM_ON, vendors: ['meta-pixel', 'meta-pixel'] } })
    ).toBe(false);
    expect(parse({ 'google-tag-manager': { ...GTM_ON, origins: ['https://evil.example'] } })).toBe(
      false
    );
    for (const bad of [
      'GTM-',
      'UA-12345-1',
      'G-ABC123',
      'GTM-ABC123&l=x',
      'GTM-ABC123"><script>',
      'https://www.googletagmanager.com/gtm.js?id=GTM-ABC123',
    ])
      expect(GtmContainerId.safeParse(bad).success, bad).toBe(false);
    expect(GtmContainerId.parse('gtm-tw8hz5ks')).toBe('GTM-TW8HZ5KS');
  });

  it('is an administrator decision: editors and keys without tenant:admin are refused', async () => {
    const { invoker } = setup();
    const editor = principal({
      capabilities: ['content:read', 'content:write', 'content:publish'],
    });
    await expect(invoker.run(useCases.getIntegrationSettings, editor, {})).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      invoker.run(useCases.updateIntegrationSettings, editor, {
        baseVersion: 0,
        settings: { ...DEFAULT_INTEGRATIONS, youtube: { enabled: true } },
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    const key = principal({
      actor: { kind: 'api-key', keyId: 'key-1' },
      capabilities: ['tenant:admin'],
    });
    await expect(
      invoker.run(useCases.updateIntegrationSettings, key, {
        baseVersion: 0,
        settings: { ...DEFAULT_INTEGRATIONS, youtube: { enabled: true } },
      })
    ).resolves.toMatchObject({ version: 1 });
  });

  it('keeps tenants apart and records who changed the setting', async () => {
    const { uow, invoker } = setup();
    await invoker.run(useCases.updateIntegrationSettings, principal(), {
      baseVersion: 0,
      settings: { ...DEFAULT_INTEGRATIONS, 'google-tag-manager': GTM_ON },
    });
    expect(await invoker.run(useCases.getIntegrationPlacement, visitor(OTHER), {})).toEqual({
      embeds: [],
      tagManager: null,
    });
    const rows = uow.store
      .for(TENANT)
      .audit.filter((r) => r.operation === 'integration.settings.update');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: 'ok' });
    expect(uow.store.for(OTHER).audit).toHaveLength(0);
  });
});

describe('integration catalogue', () => {
  it('declares owner, vendor, purpose, consent, routes, fallback and exact origins per entry', () => {
    for (const [id, manifest] of Object.entries(INTEGRATIONS)) {
      for (const field of ['name', 'vendor', 'owner', 'purpose', 'fallback'] as const)
        expect(manifest[field].length, `${id}.${field}`).toBeGreaterThan(0);
      expect(manifest.version).toBeGreaterThan(0);
    }
    const all = [
      ...Object.values(INTEGRATIONS).map((m) => m.csp),
      ...Object.values(TAG_VENDORS).map((v) => v.csp),
    ].flatMap((csp) => [...csp.script, ...csp.connect, ...csp.img, ...csp.frame]);
    for (const origin of all) {
      const url = new URL(origin);
      expect(url.protocol, origin).toBe('https:');
      expect(`${url.protocol}//${url.host}`, origin).toBe(origin);
      expect(origin, origin).not.toContain('*');
    }
  });
});

describe('integration decision', () => {
  const request: PageviewRequest = {
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
  const everything: IntegrationPlacement = {
    embeds: ['youtube', 'vimeo'],
    tagManager: { containerId: 'GTM-ABC123', category: 'marketing', vendors: ['meta-pixel'] },
  };
  const videoPage = { blockTypes: ['rich-text', 'video-embed'], embeds: ['youtube' as const] };

  it('places the embeds the page shows and the tag manager, with only their origins', () => {
    const decision = integrationDecision(request, videoPage, everything);
    expect(decision).toEqual({
      placed: true,
      embeds: ['youtube'],
      tagManager: { containerId: 'GTM-ABC123', category: 'marketing' },
      csp: {
        script: ['https://connect.facebook.net', 'https://www.googletagmanager.com'],
        connect: [
          'https://connect.facebook.net',
          'https://www.facebook.com',
          'https://www.googletagmanager.com',
        ],
        img: ['https://www.facebook.com', 'https://www.googletagmanager.com'],
        frame: ['https://www.youtube-nocookie.com'],
      },
    });
  });

  it('places an embed but no tag manager where a visitor enters personal data', () => {
    for (const input of ['form', 'signup-form', 'paywall', 'campaign-card']) {
      const decision = integrationDecision(
        request,
        { blockTypes: ['video-embed', input], embeds: ['vimeo'] },
        everything
      );
      expect(decision, input).toMatchObject({ placed: true, embeds: ['vimeo'], tagManager: null });
      if (decision.placed) expect(decision.csp.script, input).toEqual([]);
    }
  });

  it('places nothing that is switched off or not on the page', () => {
    expect(
      integrationDecision(request, videoPage, { embeds: ['vimeo'], tagManager: null })
    ).toEqual({ placed: false, reason: 'none' });
    expect(integrationDecision(request, videoPage, { embeds: [], tagManager: null })).toEqual({
      placed: false,
      reason: 'none',
    });
  });

  it('places nothing outside a successful GET of published public HTML', () => {
    const refused: [Partial<PageviewRequest>, string][] = [
      [{ method: 'POST' }, 'method'],
      [{ status: 404 }, 'status'],
      [{ status: 303 }, 'status'],
      [{ contentType: 'application/json' }, 'not-html'],
      [{ pathname: '/en/confirm/abc' }, 'confirm'],
      [{ search: '?token=abc' }, 'token'],
      [{ representation: 'admin', published: null }, 'representation'],
      [{ representation: 'preview', published: null }, 'representation'],
      [{ representation: 'reader', published: null }, 'representation'],
      [{ published: { ...request.published!, access: 'restricted' } }, 'restricted'],
    ];
    for (const [patch, reason] of refused)
      expect(integrationDecision({ ...request, ...patch }, videoPage, everything), reason).toEqual({
        placed: false,
        reason,
      });
  });
});
