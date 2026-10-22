import { beforeEach, describe, expect, it } from 'vitest';
import {
  Invoker,
  UseCaseError,
  buildRegistry,
  systemPrincipal,
  useCases,
  verifyHostname,
  type Hostname,
} from '../index.js';
import {
  FakeClock,
  FakeDns,
  MemorySiteDirectory,
  MemoryTenants,
  MemoryUnitOfWork,
  probeTenant,
} from '../testing/index.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const platform = {
  domain: 'mycel.site',
  devHosts: ['localhost'],
  platformOrigin: 'https://admin.mycel.site',
  siteUrlMode: 'hostnames' as const,
};

describe('custom domains', () => {
  let clock: FakeClock;
  let dns: FakeDns;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let sites: MemorySiteDirectory;
  const admin = systemPrincipal(TENANT, 'test');
  const other = systemPrincipal(OTHER, 'test');

  beforeEach(() => {
    clock = new FakeClock();
    dns = new FakeDns();
    uow = new MemoryUnitOfWork({ clock, dns, platform });
    const tenants = new MemoryTenants([
      probeTenant(TENANT),
      { ...probeTenant(OTHER), slug: 'other' },
    ]);
    uow.store.addPlatformHostname(probeTenant(TENANT), platform.domain, clock.now());
    uow.store.addPlatformHostname({ ...probeTenant(OTHER), slug: 'other' }, platform.domain);
    sites = new MemorySiteDirectory(uow.store, tenants);
    invoker = new Invoker(buildRegistry(), uow);
  });

  const expectCode = async (p: Promise<unknown>, code: string) =>
    expect(p).rejects.toSatisfy((e) => e instanceof UseCaseError && e.code === code);
  const list = async (principal = admin) =>
    (await invoker.run(useCases.listHostnames, principal, {})).hostnames;
  const add = (hostname: string, principal = admin) =>
    invoker.run(useCases.addHostname, principal, { hostname });

  it('lists the platform hostname as verified and primary, without a DNS instruction', async () => {
    expect(await list()).toEqual([
      {
        hostname: 'probe.mycel.site',
        kind: 'platform',
        primary: true,
        verifiedAt: clock.now().toISOString(),
      },
    ]);
  });

  it('adds a custom domain, normalised, unverified, with its TXT and CNAME instruction', async () => {
    const added = await add(' Www.Example.ORG. ');
    expect(added).toMatchObject({
      hostname: 'www.example.org',
      kind: 'custom',
      primary: false,
      verifiedAt: null,
    });
    expect(added.dns).toEqual({
      txt: { name: '_mycel-verify.www.example.org', value: expect.stringMatching(/^[\w-]{43}$/) },
      cname: { name: 'www.example.org', target: 'probe.mycel.site' },
    });
    expect((await list()).map((h) => h.hostname)).toEqual(['probe.mycel.site', 'www.example.org']);
    // Unverified: resolves, but is not allowed a certificate.
    expect((await sites.resolve('www.example.org'))?.tenant.id).toBe(TENANT);
    expect(await sites.allowed('www.example.org')).toBe(false);
  });

  it('refuses the platform domain, its subdomains, a dev host, a port and an IP', async () => {
    for (const h of ['mycel.site', 'x.mycel.site', 'localhost', 'example.org:443', '10.0.0.1'])
      await expectCode(add(h), 'invalid_input');
  });

  it('keeps hostnames globally unique with a conflict that names no owner', async () => {
    await add('www.example.org');
    await expectCode(add('www.example.org', other), 'conflict');
    await expectCode(add('WWW.example.org'), 'conflict');
    // The other tenant never sees it.
    expect((await list(other)).map((h) => h.hostname)).toEqual(['other.mycel.site']);
  });

  describe('verify', () => {
    const token = async () =>
      (await list()).find((h): h is Hostname & { dns: NonNullable<Hostname['dns']> } => !!h.dns)!
        .dns.txt.value;

    it('reports what DNS has when the token is not there, and does not verify', async () => {
      await add('www.example.org');
      dns.txtRecords.set('_mycel-verify.www.example.org', ['something-else']);
      dns.cnames.set('www.example.org', 'elsewhere.example.net');
      const r = await invoker.run(useCases.verifyHostname, admin, { hostname: 'www.example.org' });
      expect(r).toEqual({
        hostname: 'www.example.org',
        verified: false,
        verifiedAt: null,
        found: { txt: ['something-else'], cname: 'elsewhere.example.net' },
        pointsToPlatform: false,
      });
      expect(await sites.allowed('www.example.org')).toBe(false);
    });

    it('verifies when the TXT record carries the token; the CNAME is reported only', async () => {
      await add('www.example.org');
      dns.txtRecords.set('_mycel-verify.www.example.org', ['other', await token()]);
      const r = await invoker.run(useCases.verifyHostname, admin, { hostname: 'www.example.org' });
      expect(r).toMatchObject({
        verified: true,
        verifiedAt: clock.now().toISOString(),
        pointsToPlatform: false,
      });
      expect(await sites.allowed('www.example.org')).toBe(true);
      dns.cnames.set('www.example.org', 'probe.mycel.site');
      clock.advance(60_000);
      // Re-verification keeps the first verification time.
      const again = await invoker.run(useCases.verifyHostname, admin, {
        hostname: 'www.example.org',
      });
      expect(again).toMatchObject({
        verified: true,
        verifiedAt: r.verifiedAt,
        pointsToPlatform: true,
      });
    });

    it('keeps a verification when the record disappears; withdrawing is TODO #15', async () => {
      await add('www.example.org');
      dns.txtRecords.set('_mycel-verify.www.example.org', [await token()]);
      await invoker.run(useCases.verifyHostname, admin, { hostname: 'www.example.org' });
      dns.txtRecords.clear();
      const row = await uow.run(admin, (ctx) => ctx.hostnames.get('www.example.org'));
      const r = await uow.run(admin, (ctx) => verifyHostname(ctx, row!));
      expect(r).toMatchObject({ verified: false, verifiedAt: row!.verifiedAt!.toISOString() });
      expect(await sites.allowed('www.example.org')).toBe(true);
    });

    it('is not_found for the platform hostname and for another tenant’s domain', async () => {
      await add('www.example.org');
      await expectCode(
        invoker.run(useCases.verifyHostname, admin, { hostname: 'probe.mycel.site' }),
        'not_found'
      );
      await expectCode(
        invoker.run(useCases.verifyHostname, other, { hostname: 'www.example.org' }),
        'not_found'
      );
    });
  });

  describe('set_primary and remove', () => {
    const verified = async (hostname: string) => {
      const added = await add(hostname);
      dns.txtRecords.set(added.dns!.txt.name, [added.dns!.txt.value]);
      await invoker.run(useCases.verifyHostname, admin, { hostname });
    };

    it('needs a verified hostname, then the old primary becomes a redirect', async () => {
      await add('www.example.org');
      await expectCode(
        invoker.run(useCases.setPrimaryHostname, admin, { hostname: 'www.example.org' }),
        'conflict'
      );
      dns.txtRecords.set('_mycel-verify.www.example.org', [
        (await list()).find((h) => h.dns)!.dns!.txt.value,
      ]);
      await invoker.run(useCases.verifyHostname, admin, { hostname: 'www.example.org' });
      const r = await invoker.run(useCases.setPrimaryHostname, admin, {
        hostname: 'WWW.example.org',
      });
      expect(r).toMatchObject({ hostname: 'www.example.org', primary: true });
      expect((await list()).map((h) => [h.hostname, h.primary])).toEqual([
        ['probe.mycel.site', false],
        ['www.example.org', true],
      ]);
      expect((await sites.resolve('probe.mycel.site'))?.hostname.primary).toBe(false);
      // The platform hostname can become primary again.
      await invoker.run(useCases.setPrimaryHostname, admin, { hostname: 'probe.mycel.site' });
      expect((await sites.resolve('probe.mycel.site'))?.hostname.primary).toBe(true);
    });

    it('never removes the platform hostname or the primary', async () => {
      await verified('www.example.org');
      await invoker.run(useCases.setPrimaryHostname, admin, { hostname: 'www.example.org' });
      await expectCode(
        invoker.run(useCases.removeHostname, admin, { hostname: 'probe.mycel.site' }),
        'not_found'
      );
      await expectCode(
        invoker.run(useCases.removeHostname, admin, { hostname: 'www.example.org' }),
        'conflict'
      );
      await invoker.run(useCases.setPrimaryHostname, admin, { hostname: 'probe.mycel.site' });
      expect(
        await invoker.run(useCases.removeHostname, admin, { hostname: 'www.example.org' })
      ).toEqual({ hostname: 'www.example.org' });
      expect(await sites.resolve('www.example.org')).toBeNull();
      await expectCode(
        invoker.run(useCases.removeHostname, admin, { hostname: 'www.example.org' }),
        'not_found'
      );
    });

    it('is not_found from another tenant', async () => {
      await verified('www.example.org');
      await expectCode(
        invoker.run(useCases.setPrimaryHostname, other, { hostname: 'www.example.org' }),
        'not_found'
      );
      await expectCode(
        invoker.run(useCases.removeHostname, other, { hostname: 'www.example.org' }),
        'not_found'
      );
    });
  });

  it('needs tenant:admin', async () => {
    const editor = { ...admin, capabilities: ['content:write' as const] };
    await expectCode(invoker.run(useCases.listHostnames, editor, {}), 'forbidden');
    await expectCode(add('www.example.org', editor), 'forbidden');
  });
});
