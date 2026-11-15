// A live session of an erased operator (ADR 035 rule 3): the cookie is signed and stateless, so
// it still verifies after the installation erased the account; the admin reads the account on
// every request, treats a missing one as no session, and clears the cookie, so the address and
// name it carries are never shown again. The erasure itself is covered over Postgres in
// packages/db/src/operator-erasure.conformance.test.ts; this proves the hook in the running app.
// Rejected: a unit test of the hook with a stubbed runtime (it would not prove the cookie path
// and the redirect that the browser sees).

import { expect, test } from '@playwright/test';
import { eraseOperator } from '@mycel/db';
import { systemPrincipal, useCases } from '@mycel/core';
import { FakeInputHasher } from '@mycel/core/testing';
import { asOwner, tenantId, withInvoker } from './lib/invoker.js';
import { login } from './lib/login.js';

test('an erased operator loses the session on the next admin request', async ({ page }) => {
  const probe = await tenantId();
  const email = `erased-${Math.random().toString(36).slice(2, 8)}@probe.test`;
  const { operatorId } = await withInvoker((invoker) =>
    invoker.run(useCases.inviteMember, systemPrincipal(probe, 'e2e'), {
      email,
      capabilities: ['content:read'],
    })
  );
  await login(page, '/admin/probe', email);
  expect((await page.context().cookies()).map((c) => c.name)).toContain('mycel_session');

  await asOwner((owner) =>
    eraseOperator(owner, operatorId, {
      actorId: 'e2e',
      hasher: new FakeInputHasher(process.env['AUDIT_HASH_KEY']),
    })
  );
  await page.goto('/admin/probe');
  await expect(page).toHaveURL(/\/admin\/login/);
  await expect(page.locator('body')).not.toContainText(email);
  expect((await page.context().cookies()).map((c) => c.name)).not.toContain('mycel_session');
});
