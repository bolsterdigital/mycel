// The row stays tenant scoped under forced RLS. A single conditional upsert makes the first
// write and later compare-and-swap atomic; rejected: read, then unconditional update.
import type { Kysely } from 'kysely';
import {
  DEFAULT_CHROME,
  DEFAULT_THEME,
  SiteChrome,
  Theme,
  type SiteSettingsRepository,
  type BrandAssetsRepository,
  type BrandKind,
  type BrandAsset,
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

export function brandAssetsRepository(
  db: Kysely<Database>,
  tenantId: string
): BrandAssetsRepository {
  const fields = (kind: BrandKind) =>
    kind === 'logo'
      ? { bytes: 'logo_bytes' as const, version: 'logo_version' as const }
      : { bytes: 'font_bytes' as const, version: 'font_version' as const };
  return {
    async get(kind) {
      const row = await db
        .selectFrom('site_settings')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      const { bytes, version } = fields(kind);
      const data = row?.[bytes] ?? null;
      const asset: BrandAsset | null = data
        ? {
            bytes: data,
            contentType: kind === 'logo' ? 'image/webp' : 'font/woff2',
            width: kind === 'logo' ? (row?.logo_width ?? null) : null,
            height: kind === 'logo' ? (row?.logo_height ?? null) : null,
            licence: kind === 'font' ? (row?.font_licence ?? null) : null,
          }
        : null;
      return { version: row?.[version] ?? 0, asset };
    },
    async replace(kind, baseVersion, asset) {
      const changes =
        kind === 'logo'
          ? {
              logo_bytes: asset ? Buffer.from(asset.bytes) : null,
              logo_width: asset?.width ?? null,
              logo_height: asset?.height ?? null,
              logo_version: baseVersion + 1,
            }
          : {
              font_bytes: asset ? Buffer.from(asset.bytes) : null,
              font_licence: asset?.licence ?? null,
              font_version: baseVersion + 1,
            };
      const version = fields(kind).version;
      if (baseVersion > 0) {
        const changed = await db
          .updateTable('site_settings')
          .set(changes)
          .where('tenant_id', '=', tenantId)
          .where(version, '=', baseVersion)
          .returning(version)
          .executeTakeFirst();
        return changed?.[version] ?? null;
      }
      const row = await db
        .insertInto('site_settings')
        .values({
          tenant_id: tenantId,
          theme: JSON.stringify(DEFAULT_THEME),
          theme_version: 0,
          chrome: JSON.stringify(DEFAULT_CHROME),
          chrome_version: 0,
          ...changes,
        })
        .onConflict((oc) =>
          oc
            .column('tenant_id')
            .doUpdateSet(changes)
            .where(`site_settings.${version}`, '=', baseVersion)
        )
        .returning(version)
        .executeTakeFirst();
      return row?.[version] ?? null;
    },
  };
}
