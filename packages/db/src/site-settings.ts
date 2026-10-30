// The row stays tenant scoped under forced RLS. Every setting on it (theme, chrome, general,
// images, logo, font) is a value with its own version, written through one compare-and-set (`writeVersioned`). A
// column that was never written is null and reads as the current default, so the first write of
// one setting does not freeze the defaults of the others (TODO #53). Rejected: read, then
// unconditional update; and one upsert per setting, which drifted into three copies.
import type { Kysely, Updateable } from 'kysely';
import {
  DEFAULT_CHROME,
  DEFAULT_GENERAL,
  DEFAULT_IMAGES,
  DEFAULT_THEME,
  SiteChrome,
  SiteGeneral,
  SiteImages,
  Theme,
  type SiteSettingsRepository,
  type BrandAssetsRepository,
  type BrandKind,
  type BrandAsset,
} from '@mycel/core';
import type { Database } from './infra/schema.js';

type Row = Database['site_settings'];
type VersionColumn =
  | 'theme_version'
  | 'chrome_version'
  | 'general_version'
  | 'images_version'
  | 'logo_version'
  | 'font_version';

/**
 * Writes `changes` and moves `version` from `baseVersion` to the next, or returns null when the
 * stored version is another. At version 0 the row may not exist yet: the insert makes it, with
 * every other column at its default, and a competing first write meets the conflict clause.
 */
async function writeVersioned(
  db: Kysely<Database>,
  tenantId: string,
  version: VersionColumn,
  baseVersion: number,
  changes: Updateable<Row>
): Promise<number | null> {
  const set = { ...changes, [version]: baseVersion + 1 };
  const row =
    baseVersion > 0
      ? await db
          .updateTable('site_settings')
          .set(set)
          .where('tenant_id', '=', tenantId)
          .where(version, '=', baseVersion)
          .returning(version)
          .executeTakeFirst()
      : await db
          .insertInto('site_settings')
          .values({ ...set, tenant_id: tenantId })
          .onConflict((oc) =>
            oc
              .column('tenant_id')
              .doUpdateSet(set)
              .where(`site_settings.${version}`, '=', baseVersion)
          )
          .returning(version)
          .executeTakeFirst();
  return row?.[version] ?? null;
}

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
      return {
        version: row?.theme_version ?? 0,
        value: row?.theme == null ? DEFAULT_THEME : Theme.parse(row.theme),
      };
    },
    async chrome() {
      const row = await db
        .selectFrom('site_settings')
        .select(['chrome', 'chrome_version'])
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      return {
        version: row?.chrome_version ?? 0,
        value: row?.chrome == null ? DEFAULT_CHROME : SiteChrome.parse(row.chrome),
      };
    },
    updateTheme: (baseVersion, value) =>
      writeVersioned(db, tenantId, 'theme_version', baseVersion, { theme: JSON.stringify(value) }),
    updateChrome: (baseVersion, value) =>
      writeVersioned(db, tenantId, 'chrome_version', baseVersion, {
        chrome: JSON.stringify(value),
      }),
    async general() {
      const row = await db
        .selectFrom('site_settings')
        .select(['general', 'general_version'])
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      // A zone the runtime stopped knowing (a tzdata update) falls back, as an operator's does
      // (`preferencesOf`), rather than failing every admin page of the site.
      const parsed = row?.general == null ? null : SiteGeneral.safeParse(row.general);
      return {
        version: row?.general_version ?? 0,
        value: parsed?.success ? parsed.data : DEFAULT_GENERAL,
      };
    },
    updateGeneral: (baseVersion, value) =>
      writeVersioned(db, tenantId, 'general_version', baseVersion, {
        general: JSON.stringify(value),
      }),
    async images() {
      const row = await db
        .selectFrom('site_settings')
        .select(['images', 'images_version'])
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      return {
        version: row?.images_version ?? 0,
        value: row?.images == null ? DEFAULT_IMAGES : SiteImages.parse(row.images),
      };
    },
    updateImages: (baseVersion, value) =>
      writeVersioned(db, tenantId, 'images_version', baseVersion, {
        images: JSON.stringify(value),
      }),
  };
}

export function brandAssetsRepository(
  db: Kysely<Database>,
  tenantId: string
): BrandAssetsRepository {
  return {
    async get(kind: BrandKind) {
      // One kind's columns only: the other kind's bytea never leaves the database for this read.
      if (kind === 'logo') {
        const row = await db
          .selectFrom('site_settings')
          .select(['logo_bytes', 'logo_width', 'logo_height', 'logo_version'])
          .where('tenant_id', '=', tenantId)
          .executeTakeFirst();
        const asset: BrandAsset | null = row?.logo_bytes
          ? {
              bytes: row.logo_bytes,
              contentType: 'image/webp',
              width: row.logo_width,
              height: row.logo_height,
              licence: null,
            }
          : null;
        return { version: row?.logo_version ?? 0, asset };
      }
      const row = await db
        .selectFrom('site_settings')
        .select(['font_bytes', 'font_licence', 'font_version'])
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      const asset: BrandAsset | null = row?.font_bytes
        ? {
            bytes: row.font_bytes,
            contentType: 'font/woff2',
            width: null,
            height: null,
            licence: row.font_licence,
          }
        : null;
      return { version: row?.font_version ?? 0, asset };
    },
    replace: (kind, baseVersion, asset) =>
      kind === 'logo'
        ? writeVersioned(db, tenantId, 'logo_version', baseVersion, {
            logo_bytes: asset ? Buffer.from(asset.bytes) : null,
            logo_width: asset?.width ?? null,
            logo_height: asset?.height ?? null,
          })
        : writeVersioned(db, tenantId, 'font_version', baseVersion, {
            font_bytes: asset ? Buffer.from(asset.bytes) : null,
            font_licence: asset?.licence ?? null,
          }),
  };
}
