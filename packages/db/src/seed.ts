// Dev seed: the probe tenant (platform path, operator connection) and its signup form and page
// (tenant path: the page goes through the `content.page.create` use case like any front would),
// a pending admin to log in as, and, when MYCEL_API_KEY is set, an API key with that token.
// Idempotent: running it twice leaves one tenant, one form, one page, one admin, one key.

import {
  Invoker,
  UseCaseError,
  buildRegistry,
  hashApiKey,
  systemPrincipal,
  useCases,
  type KeyCapability,
  type Signer,
} from '@mycel/core';
import { probeForm, probePage } from '@mycel/core/testing';
import { createDb, createUnitOfWork, upsertTenant, uuidv7, uuidv7Ids } from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
if (!operatorUrl) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(1);
}
const operatorDb = createDb(operatorUrl);
const appDb = createDb(process.env['APP_DATABASE_URL'] ?? operatorUrl);

// The seed never signs anything; failing loudly beats a silently insecure signer.
const noSigner: Signer = {
  sign: () => Promise.reject(new Error('seed has no signer')),
  verify: () => Promise.reject(new Error('seed has no signer')),
};

try {
  const tenant = await upsertTenant(operatorDb, {
    id: uuidv7(),
    slug: 'probe',
    name: 'Probe',
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
  });
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: noSigner,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = systemPrincipal(tenant.id, 'seed');

  const existing = await invoker.run(useCases.getPage, admin, { slug: 'signup' }).catch(() => null);
  if (existing) {
    console.log(
      `tenant ${tenant.slug} (${tenant.id}) already seeded: /${tenant.slug}/${existing.slug}`
    );
  } else {
    const form = probeForm(uuidv7());
    await uow.run(admin, (ctx) => ctx.forms.insert(form));
    const page = await invoker.run(useCases.createPage, admin, probePage(form.id));
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
  // without clicking one together first. Upsert on the hash: a rerun changes nothing.
  const token = process.env['MYCEL_API_KEY'];
  if (token) {
    const keyHash = await hashApiKey(token);
    const capabilities: KeyCapability[] = [
      'content:read',
      'forms:read',
      'supporters:read',
      'content:write',
    ];
    const created = await uow
      .run(admin, async (ctx) => {
        await ctx.apiKeys.insert({
          id: uuidv7(),
          name: 'seed',
          prefix: token.slice(0, 12),
          keyHash,
          capabilities,
          createdBy: admin.actor,
          createdAt: new Date(),
        });
        return true;
      })
      .catch((e: { code?: string }) => {
        if (e.code === '23505') return false; // unique key_hash: seeded before
        throw e;
      });
    if (created) console.log(`seeded API key "seed" for ${tenant.slug} from MYCEL_API_KEY`);
  }
} finally {
  await operatorDb.destroy();
  await appDb.destroy();
}
