// `mycel setup` against Postgres (TODO #18a): the platform function creates the tenant on the
// operator connection, the runtime's invoker invites and adds the hostname as mycel_app, exactly
// as `docker compose run --rm worker mycel setup` does. A second run changes nothing, the
// operator stays pending until the first login, and the printed DNS instruction is the one the
// admin shows. The CI compose job runs the same command in the image as a non-superuser owner.
//
// Skips without the three database URLs; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemPrincipal, useCases } from '@mycel/core';
import { createDb, createTenant, getTenantBySlug, uuidv7 } from '@mycel/db';
import { requireDatabase, migrateSchema } from '@mycel/db/testing';
import { runSuffix } from '@mycel/core/testing';
import { runSetup, type SetupDeps } from './cli.js';
import { createRuntime, inputHasherOf, loadConfig } from './compose.js';

const env = process.env;
const { skip } = requireDatabase('app', 'auth');

describe.skipIf(skip)('mycel setup against Postgres', () => {
  // Built in beforeAll, not in the describe body: Vitest runs the body while collecting even
  // when the suite is skipped, and loadConfig throws without the database URLs.
  let runtime: ReturnType<typeof createRuntime>;
  let db: ReturnType<typeof createDb>;
  let deps: SetupDeps;
  const run = runSuffix();
  const slug = `setup-${run}`;
  const input = {
    slug,
    name: 'Setup',
    locales: ['nl', 'en'],
    operator: `admin-${run}@example.org`,
    hostname: `www.${slug}.example`,
  };

  beforeAll(async () => {
    const config = loadConfig({
      ...env,
      SIGNING_SECRET: env['SIGNING_SECRET'] ?? 'conformance-signing-secret',
      PUBLIC_BASE_URL: 'https://admin.setup.test',
      MAIL_FROM: env['MAIL_FROM'] ?? 'noreply@example.org',
      MAILER: 'console',
      MAIL_SPOOL_DIR: undefined,
      PLATFORM_DOMAIN: 'setup.test',
    });
    runtime = createRuntime(config, { service: 'cli', writeLog: () => {} });
    db = createDb(env['DATABASE_URL']!);
    deps = {
      tenantBySlug: (s) => getTenantBySlug(db, s),
      createTenant: (input) =>
        createTenant(db, { id: uuidv7(), ...input }, runtime.platform, {
          actorId: 'cli',
          hasher: inputHasherOf(config),
        }),
      invoker: runtime.invoker,
      platformOrigin: runtime.platform.platformOrigin,
    };
    await migrateSchema(env['DATABASE_URL']!);
  });

  afterAll(async () => {
    await runtime.close();
    await db.destroy();
  });

  it('creates tenant, pending operator and hostname once, and is a no-op the second time', async () => {
    const first = await runSetup(deps, input);
    expect(first.changed).toBe(true);
    expect(first.tenant).toMatchObject({ slug, primaryHostname: `${slug}.setup.test` });

    const admin = systemPrincipal(first.tenant.id, 'test');
    const { members } = await runtime.invoker.run(useCases.listMembers, admin, {});
    expect(members).toEqual([
      expect.objectContaining({
        email: input.operator,
        capabilities: ['tenant:admin'],
        pending: true,
      }),
    ]);
    const { hostnames } = await runtime.invoker.run(useCases.listHostnames, admin, {});
    const custom = hostnames.find((h) => h.kind === 'custom')!;
    expect(custom).toMatchObject({ hostname: input.hostname, verifiedAt: null });
    expect(first.lines).toContain(
      `    TXT   _mycel-verify.${input.hostname}  "${custom.dns!.txt.value}"`
    );
    expect(first.lines).toContain(`    CNAME ${input.hostname}  ${slug}.setup.test`);
    expect(first.lines.at(-1)).toBe(`admin: https://admin.setup.test/admin/${slug}`);

    const second = await runSetup(deps, input);
    expect(second.changed).toBe(false);
    expect(second.tenant.id).toBe(first.tenant.id);
    expect(second.lines.at(-1)).toBe('nothing changed');
    expect((await runtime.invoker.run(useCases.listMembers, admin, {})).members).toEqual(members);
    expect((await runtime.invoker.run(useCases.listHostnames, admin, {})).hostnames).toEqual(
      hostnames
    );
  });
});
