// Dev seed: the probe tenant (platform path, operator connection) and its signup form and page
// (tenant path: the page goes through `content.item.create` and an explicit `content.item.publish`
// per locale like any front would), a pending admin to log in as, entitlements with the credit on
// and a supporter cap, and, when MYCEL_API_KEY is set, an API key with that token.
// Idempotent: running it twice leaves one tenant, one form, one page, one admin, one key.

import {
  Invoker,
  UseCaseError,
  buildRegistry,
  systemPrincipal,
  useCases,
  type Signer,
} from '@mycel/core';
import {
  createDb,
  createIdentityStore,
  createUnitOfWork,
  ensureTenant,
  setEntitlements,
  uuidv7,
  uuidv7Ids,
} from '../index.js';
import { seedApiKey } from './seed-key.js';
import {
  FakeDns,
  FakeInputHasher,
  memoryPlatform,
  probeForm,
  publishProbePage,
} from '@mycel/core/testing';

const operatorUrl = process.env['DATABASE_URL'];
const platformDomain = process.env['PLATFORM_DOMAIN'];
if (!operatorUrl || !platformDomain) {
  console.error('DATABASE_URL and PLATFORM_DOMAIN must be set (see .env.example)');
  process.exit(1);
}
const operatorDb = createDb(operatorUrl);
const appDb = createDb(process.env['APP_DATABASE_URL'] ?? operatorUrl);

// The seed never signs anything; failing loudly beats a silently insecure signer.
const noSigner: Signer = {
  sign: () => Promise.reject(new Error('seed has no signer')),
  verify: () => Promise.reject(new Error('seed has no signer')),
  hashIp: () => {
    throw new Error('seed has no signer');
  },
};

// Dev only: the test hasher is the same HMAC-SHA256 as the API's adapter, under the same key.
const inputHasher = new FakeInputHasher(process.env['AUDIT_HASH_KEY']);

try {
  // The platform path every tenant takes (platform.ts), so the probe tenant has its audit row.
  const platform = { ...memoryPlatform, domain: platformDomain };
  const seedActor = { actorId: 'seed', hasher: inputHasher };
  const tenant = await ensureTenant(
    operatorDb,
    { id: uuidv7(), slug: 'probe', name: 'Probe', defaultLocale: 'nl', locales: ['nl', 'en'] },
    platform,
    seedActor
  );
  // A hosted free tier in miniature (ADR 015 rules 2 and 5), so dev and e2e show the footer
  // credit and run against a real cap. Prices and tier names stay out of this repository.
  await setEntitlements(
    operatorDb,
    tenant.id,
    { remove_branding: false, 'supporters.max': 250 },
    seedActor
  );

  // The seed verifies no domains and builds no URLs: the in-memory DNS and platform defaults
  // (with the real platform domain) satisfy the unit of work without a resolver.
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: noSigner,
    inputHasher,
    dns: new FakeDns(),
    platform,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = systemPrincipal(tenant.id, 'seed');

  const [existing] = (
    await invoker.run(useCases.listItems, admin, { type: 'page', slug: 'signup' })
  ).items;
  if (existing) {
    console.log(
      `tenant ${tenant.slug} (${tenant.id}) already seeded: /${tenant.slug}/${existing.slug} and ${tenant.slug}.${platformDomain}`
    );
  } else {
    const form = probeForm(uuidv7());
    await uow.run(admin, (ctx) => ctx.forms.insert(form));
    const page = await publishProbePage(invoker, admin, form.id);
    console.log(
      `seeded tenant ${tenant.slug} (${tenant.id}), form ${form.id}, page /${tenant.slug}/${page.slug}`
    );
  }

  // The first admin is invited like any member: a pending operator who becomes real at the
  // first login with this (verified) address. Locally that login is the mock IdP.
  const adminEmail = process.env['MYCEL_SEED_OPERATOR_EMAIL'] ?? 'admin@probe.test';
  try {
    await invoker.run(useCases.inviteMember, admin, {
      email: adminEmail,
      capabilities: ['tenant:admin'],
    });
    console.log(`invited ${adminEmail} as tenant:admin of ${tenant.slug}`);
  } catch (e) {
    if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
  }

  // A key whose token the operator chose (dev .env, scripts/e2e.mjs), so API and MCP work
  // without clicking one together first. A rerun changes nothing, and refuses a stale key.
  const token = process.env['MYCEL_API_KEY'];
  const outcome = token
    ? await seedApiKey(uow, createIdentityStore(operatorDb, uuidv7Ids), admin, token).catch(
        (e: Error) => {
          console.error(e.message);
          process.exitCode = 1;
          return 'refused';
        }
      )
    : 'none';
  if (outcome === 'created')
    console.log(`seeded API key "seed" for ${tenant.slug} from MYCEL_API_KEY`);
} finally {
  await operatorDb.destroy();
  await appDb.destroy();
}
