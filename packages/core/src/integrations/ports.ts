// The integrations module's port (docs/reference/integrations.md): the tenant's switched-on
// catalogue entries, a versioned value on the site settings row under the same RLS boundary as
// the other site settings. The catalogue itself is code, not stored.
// Rejected: a row per integration (the setting is read whole on every public page and written
// whole by one form; rows would add joins and a partial-write state for no gain).

import type { IntegrationSettings } from './model.js';

export interface IntegrationSettingsRepository {
  get(): Promise<{ version: number; value: IntegrationSettings }>;
  /** Compare-and-set: the next version, or null when the stored version is not `baseVersion`. */
  update(baseVersion: number, value: IntegrationSettings): Promise<number | null>;
}

declare module '../ports.js' {
  interface TransactionContext {
    integrationSettings: IntegrationSettingsRepository;
  }
}
