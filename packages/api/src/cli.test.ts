// The `mycel` command line without a database: the argument parser, and `setup` against the
// memory ports (invite and hostnames go through the real use cases; only tenant creation, a
// platform function on the operator connection, is a stand-in). The same run against Postgres
// is setup.conformance.test.ts.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENTITLEMENTS,
  Invoker,
  UseCaseError,
  buildRegistry,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import { FakeClock, FakeDns, MemoryUnitOfWork } from '@mycel/core/testing';
import { UsageError, parseCommand, runSetup, version, type SetupTenant } from './cli.js';

describe('parseCommand', () => {
  it('reads setup with its flags in either form, locales defaulting to nl', () => {
    expect(
      parseCommand([
        'setup',
        '--tenant',
        'demo',
        '--name=Demo site',
        '--operator',
        'admin@example.org',
        '--locales',
        'nl, en',
        '--hostname',
        'www.example.org',
      ])
    ).toEqual({
      kind: 'setup',
      input: {
        slug: 'demo',
        name: 'Demo site',
        operator: 'admin@example.org',
        locales: ['nl', 'en'],
        hostname: 'www.example.org',
      },
    });
    expect(
      parseCommand(['setup', '--tenant', 'demo', '--name', 'Demo', '--operator', 'a@example.org'])
    ).toEqual({
      kind: 'setup',
      input: { slug: 'demo', name: 'Demo', operator: 'a@example.org', locales: ['nl'] },
    });
  });

  it('keeps the arguments of the platform commands it took over from scripts/platform.mjs', () => {
    expect(parseCommand(['tenants', 'list'])).toEqual({ kind: 'tenants.list' });
    expect(parseCommand(['tenants', 'create', 'demo', 'Demo', 'nl,en'])).toEqual({
      kind: 'tenants.create',
      slug: 'demo',
      name: 'Demo',
      locales: ['nl', 'en'],
    });
    expect(parseCommand(['entitlements', 'set', 'demo', '{"supporters.max": 250}'])).toEqual({
      kind: 'entitlements.set',
      slug: 'demo',
      document: { 'supporters.max': 250 },
    });
    expect(parseCommand(['status', 'set', 'demo', 'suspended'])).toEqual({
      kind: 'status.set',
      slug: 'demo',
      status: 'suspended',
    });
    expect(parseCommand(['ops', 'summary'])).toEqual({ kind: 'ops.summary' });
    expect(parseCommand(['ops', 'list', 'mail', 'demo'])).toEqual({
      kind: 'ops.list',
      list: 'mail',
      slug: 'demo',
    });
    expect(parseCommand(['ops', 'retry', 'outbox', 'x1'])).toEqual({
      kind: 'ops.recover',
      action: 'retry',
      queue: 'outbox',
      id: 'x1',
    });
    expect(parseCommand(['ops', 'close', 'jobs', 'j1'])).toMatchObject({ action: 'close' });
    expect(parseCommand(['version'])).toEqual({ kind: 'version' });
    expect(parseCommand(['blob', 'init'])).toEqual({ kind: 'blob.init' });
  });

  it('reads export, import and erasures apply (TODO #18d)', () => {
    expect(parseCommand(['export', 'demo', '--out', 'demo.tar'])).toEqual({
      kind: 'export',
      slug: 'demo',
      out: 'demo.tar',
    });
    expect(parseCommand(['import', 'demo.tar'])).toEqual({ kind: 'import', path: 'demo.tar' });
    expect(parseCommand(['import', 'dir', '--slug=demo2'])).toEqual({
      kind: 'import',
      path: 'dir',
      slug: 'demo2',
    });
    expect(parseCommand(['erasures', 'apply'])).toEqual({ kind: 'erasures.apply' });
    expect(parseCommand(['erasures', 'apply', '--tenant', 'demo'])).toEqual({
      kind: 'erasures.apply',
      slug: 'demo',
    });
  });

  it('refuses what it does not know instead of guessing', () => {
    for (const argv of [
      [],
      ['bogus'],
      ['setup', '--tenant', 'demo', '--name', 'Demo'],
      ['setup', '--tenant', 'demo', '--name', 'Demo', '--operator', 'a@example.org', '--force'],
      ['setup', '--tenant', '--name', 'Demo'],
      ['setup', 'demo'],
      ['entitlements', 'set', 'demo', '{not json'],
      ['status', 'set', 'demo', 'deleted'],
      ['ops', 'close', 'outbox', 'x1'],
      ['ops', 'list', 'tenants'],
      ['version', 'extra'],
      ['export', 'demo'],
      ['export', '--out', 'x'],
      ['import'],
      ['import', 'x', '--tenant', 'y'],
      ['erasures'],
      ['erasures', 'apply', 'demo'],
    ])
      expect(() => parseCommand(argv), argv.join(' ')).toThrow(UsageError);
  });

  it('reports the version of the root package', () => {
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('runSetup', () => {
  const platform = {
    domain: 'mycel.test',
    devHosts: [],
    platformOrigin: 'https://admin.mycel.test',
    siteUrlMode: 'hostnames' as const,
  };
  const TENANT = '01900000-0000-7000-8000-00000000cccc';

  function harness() {
    const clock = new FakeClock();
    const uow = new MemoryUnitOfWork({ clock, dns: new FakeDns(), platform });
    const invoker = new Invoker(buildRegistry(), uow);
    const tenants = new Map<string, SetupTenant>();
    let creates = 0;
    const deps = {
      invoker,
      platformOrigin: platform.platformOrigin,
      tenantBySlug: async (slug: string) => tenants.get(slug) ?? null,
      createTenant: async (input: { slug: string; name: string; locales: string[] }) => {
        creates += 1;
        const t: SetupTenant = {
          id: TENANT,
          ...input,
          status: 'active',
          primaryHostname: `${input.slug}.${platform.domain}`,
          entitlements: DEFAULT_ENTITLEMENTS,
        };
        tenants.set(input.slug, t);
        uow.store.addPlatformHostname({ ...t, defaultLocale: input.locales[0]! }, platform.domain);
        return t;
      },
    };
    const admin = systemPrincipal(TENANT, 'test');
    return { deps, uow, invoker, admin, creates: () => creates };
  }
  const input = {
    slug: 'demo',
    name: 'Demo',
    locales: ['nl', 'en'],
    operator: 'admin@example.org',
    hostname: 'WWW.Example.org.',
  };

  it('creates the tenant, invites a pending admin, adds the hostname and prints its DNS', async () => {
    const { deps, invoker, admin } = harness();
    const report = await runSetup(deps, input);
    expect(report.changed).toBe(true);
    const { members } = await invoker.run(useCases.listMembers, admin, {});
    expect(members).toEqual([
      expect.objectContaining({ email: 'admin@example.org', capabilities: ['tenant:admin'] }),
    ]);
    const { hostnames } = await invoker.run(useCases.listHostnames, admin, {});
    const custom = hostnames.find((h) => h.kind === 'custom')!;
    expect(custom).toMatchObject({ hostname: 'www.example.org', verifiedAt: null });
    const text = report.lines.join('\n');
    expect(text).toContain(`TXT   _mycel-verify.www.example.org  "${custom.dns!.txt.value}"`);
    expect(text).toContain('CNAME www.example.org  demo.mycel.test');
    expect(report.lines.at(-1)).toBe('admin: https://admin.mycel.test/admin/demo');
  });

  it('changes nothing on a second run with the same arguments, and says so', async () => {
    const { deps, invoker, admin, creates } = harness();
    const first = await runSetup(deps, input);
    const before = await invoker.run(useCases.listHostnames, admin, {});
    const second = await runSetup(deps, input);
    expect(second.changed).toBe(false);
    expect(second.lines.at(-1)).toBe('nothing changed');
    expect(creates()).toBe(1);
    expect(await invoker.run(useCases.listHostnames, admin, {})).toEqual(before);
    expect((await invoker.run(useCases.listMembers, admin, {})).members).toHaveLength(1);
    // The DNS instruction is printed again, with the same token.
    const txt = (r: typeof first) => r.lines.find((l) => l.includes('TXT'));
    expect(txt(second)).toBe(txt(first));
  });

  it('leaves an existing tenant as it is and notes a different name', async () => {
    const { deps } = harness();
    const { hostname: _, ...withoutHostname } = input;
    await runSetup(deps, withoutHostname);
    const report = await runSetup(deps, { ...withoutHostname, name: 'Other name' });
    expect(report.changed).toBe(false);
    expect(report.lines.join('\n')).toContain('setup changes neither');
  });

  it('keeps the conflict when another tenant holds the hostname', async () => {
    const { deps, uow, invoker } = harness();
    const OTHER = '01900000-0000-7000-8000-00000000dddd';
    uow.store.addPlatformHostname(
      { id: OTHER, slug: 'other', name: 'Other', defaultLocale: 'nl', locales: ['nl'] },
      platform.domain
    );
    await invoker.run(useCases.addHostname, systemPrincipal(OTHER, 'test'), {
      hostname: 'www.example.org',
    });
    await expect(runSetup(deps, input)).rejects.toSatisfy(
      (e) => e instanceof UseCaseError && e.code === 'conflict'
    );
  });
});
