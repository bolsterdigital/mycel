// A live session of an erased operator (ADR 035 rule 3), run by admin.spec.ts: the signed cookie
// still verifies after the installation erased the account, so the admin reads the account on
// every request, treats a missing one as no session and clears the cookie; the address it carries
// is never shown again. The erasure itself: packages/db/src/operators/erasure.conformance.test.ts.
// Here, apart from the spec, because admin.spec.ts is at its size limit.

import { expect, type Page } from '@playwright/test';
import { eraseOperator } from '@mycel/db';
import { systemPrincipal, useCases } from '@mycel/core';
import { FakeInputHasher } from '@mycel/core/testing';
import { asOwner, tenantId, withInvoker } from './invoker';
import { login } from './login';

export async function erasedSession(page: Page) {
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
}
