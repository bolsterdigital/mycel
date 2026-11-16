// The two members of probe that the live-preview tests of content-admin.spec.ts log in as: an
// admin and a reader with only `content:read`. Invited once per database; a second invite is a
// conflict and leaves the member as it is. Here, apart from the spec, because that spec is at its
// byte limit. Rejected: a seeded member, which every other database would carry too.

import { UseCaseError, systemPrincipal, useCases } from '@mycel/core';
import { tenantId, withInvoker } from '../invoker';

export const LIVE_ADMIN = 'live-preview-admin@probe.test';
export const LIVE_READER = 'live-preview-reader@probe.test';

export async function ensureLiveAdmin() {
  const probe = await tenantId();
  await withInvoker(async (invoker) => {
    for (const [email, capability] of [
      [LIVE_ADMIN, 'tenant:admin'],
      [LIVE_READER, 'content:read'],
    ] as const) {
      try {
        await invoker.run(useCases.inviteMember, systemPrincipal(probe, 'e2e'), {
          email,
          capabilities: [capability],
        });
      } catch (e) {
        if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
      }
    }
  });
}
