// The row stays tenant scoped under forced RLS. A single conditional upsert makes the first
// write and later compare-and-swap atomic; rejected: read, then unconditional update.
import type { Kysely } from 'kysely';
import {
  DEFAULT_CHROME,
  DEFAULT_THEME,
  SiteChrome,
  Theme,
  type SiteSettingsRepository,
} from '@mycel/core';
import type { Database } from './schema.js';
export function siteSettingsRepository(
  db: Kysely<Database>,
  tenantId: string
): SiteSettingsRepository {
  return {
    async theme() {
      const row = await db
        .selectFrom('site_settings')
        .select(['theme', 'theme_version'])
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      return row
        ? { version: row.theme_version, value: Theme.parse(row.theme) }
        : { version: 0, value: DEFAULT_THEME };
    },
    async chrome() {
      const row = await db
        .selectFrom('site_settings')
        .select(['chrome', 'chrome_version'])
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      return row
        ? { version: row.chrome_version, value: SiteChrome.parse(row.chrome) }
        : { version: 0, value: DEFAULT_CHROME };
    },
    async updateTheme(baseVersion, value) {
      if (baseVersion > 0) {
        const changed = await db
          .updateTable('site_settings')
          .set({ theme: JSON.stringify(value), theme_version: baseVersion + 1 })
          .where('tenant_id', '=', tenantId)
          .where('theme_version', '=', baseVersion)
          .returning('theme_version')
          .executeTakeFirst();
        return changed?.theme_version ?? null;
      }
      const row = await db
        .insertInto('site_settings')
        .values({
          tenant_id: tenantId,
          theme: JSON.stringify(value),
          theme_version: 1,
          chrome: JSON.stringify(DEFAULT_CHROME),
          chrome_version: 0,
        })
        .onConflict((oc) =>
          oc
            .column('tenant_id')
            .doUpdateSet({ theme: JSON.stringify(value), theme_version: baseVersion + 1 })
            .where('site_settings.theme_version', '=', baseVersion)
        )
        .returning('theme_version')
        .executeTakeFirst();
      return baseVersion === 0 && row?.theme_version !== 1 ? null : (row?.theme_version ?? null);
    },
    async updateChrome(baseVersion, value) {
      if (baseVersion > 0) {
        const changed = await db
          .updateTable('site_settings')
          .set({ chrome: JSON.stringify(value), chrome_version: baseVersion + 1 })
          .where('tenant_id', '=', tenantId)
          .where('chrome_version', '=', baseVersion)
          .returning('chrome_version')
          .executeTakeFirst();
        return changed?.chrome_version ?? null;
      }
      const row = await db
        .insertInto('site_settings')
        .values({
          tenant_id: tenantId,
          theme: JSON.stringify(DEFAULT_THEME),
          theme_version: 0,
          chrome: JSON.stringify(value),
          chrome_version: 1,
        })
        .onConflict((oc) =>
          oc
            .column('tenant_id')
            .doUpdateSet({ chrome: JSON.stringify(value), chrome_version: baseVersion + 1 })
            .where('site_settings.chrome_version', '=', baseVersion)
        )
        .returning('chrome_version')
        .executeTakeFirst();
      return baseVersion === 0 && row?.chrome_version !== 1 ? null : (row?.chrome_version ?? null);
    },
  };
}
