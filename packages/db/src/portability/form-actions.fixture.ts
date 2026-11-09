// Seed private form configuration for the portable archive round trip. Rejected: empty settings
// rows, which exercise table presence without proving the versioned action document survives.
import { useCases, type Invoker, type Principal, type FormMailSettings } from '@mycel/core';
export async function seedFormActions(
  invoker: Invoker,
  admin: Principal,
  formId: string,
  mail: FormMailSettings
) {
  await invoker.run(useCases.updateFormFeeds, admin, {
    baseVersion: 0,
    value: {
      feeds: [
        {
          id: 'unconnected',
          formId,
          enabled: false,
          connectionId: null,
          connectionVersion: null,
          scope: 'newsletter',
          confirmationOwner: 'mycel',
          mapping: [{ fieldId: 'email', target: 'email' }],
        },
      ],
    },
  });
  await invoker.run(useCases.updateFormMailSettings, admin, {
    baseVersion: 0,
    value: mail,
  });
}
