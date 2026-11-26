// A site's uploaded fonts (MY-302, ADR 013 amendment of 2026-11-26). Reading is the tenant
// port `siteFonts`; writing is a platform operation the `mycel fonts` command runs: the rows as
// mycel_app in the tenant's context (forced RLS, 0092), then the audit row as mycel_platform in
// the same transaction, as every platform mutation does (platform.ts). The rules are core's
// (`theme/site-fonts.ts`); the bytes are checked by the caller's woff2 validator before anything
// is written. Rejected: writing as mycel_platform (it has no grant on tenant rows, and should not
// get one for this), and a use case with a constructed principal (ADR 035 rejected the same).
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  SITE_FONT_REMOVE,
  SITE_FONT_UPLOAD,
  SiteFontFamilyInput,
  SiteFontStyle,
  SiteFontWeight,
  checkSiteFontFace,
  hashInput,
  type SiteFont,
  type SiteFontRole,
  type SiteFontsRepository,
} from '@mycel/core';
import { recordPlatformAudit } from '../audit.js';
import { toIso } from '../infra/dates.js';
import { uuidv7 } from '../infra/ids.js';
import type { Database } from '../infra/schema.js';
import { enterTenant, setRole } from '../infra/roles.js';
import type { PlatformActor } from '../platform.js';

type Trx = Kysely<Database>;

async function readFonts(trx: Trx, role?: SiteFontRole): Promise<SiteFont[]> {
  let families = trx.selectFrom('site_fonts').selectAll().orderBy('role');
  if (role) families = families.where('role', '=', role);
  const rows = await families.execute();
  if (!rows.length) return [];
  let faces = trx
    .selectFrom('site_font_faces')
    .select([
      'role',
      'weight',
      'style',
      'sha256',
      (eb) => eb.fn('octet_length', ['bytes']).as('size'),
    ])
    .orderBy('role')
    .orderBy('style', 'desc')
    .orderBy('weight');
  if (role) faces = faces.where('role', '=', role);
  const faceRows = await faces.execute();
  return rows.map((r) => ({
    role: r.role,
    family: r.family,
    category: r.category,
    licence: {
      holder: r.licence_holder,
      source: r.licence_source,
      domains: r.licence_domains,
      confirmedAt: toIso(r.licence_confirmed_at),
    },
    updatedAt: toIso(r.updated_at),
    faces: faceRows
      .filter((f) => f.role === r.role)
      .map((f) => ({ weight: f.weight, style: f.style, sha256: f.sha256, bytes: Number(f.size) })),
  }));
}

export function siteFontsRepository(db: Trx, _tenantId: string): SiteFontsRepository {
  return {
    list: () => readFonts(db),
    async face(role, weight, style) {
      const row = await db
        .selectFrom('site_font_faces')
        .select(['bytes', 'sha256'])
        .where('role', '=', role)
        .where('weight', '=', weight)
        .where('style', '=', style)
        .executeTakeFirst();
      return row ? { bytes: new Uint8Array(row.bytes), sha256: row.sha256 } : null;
    },
  };
}

async function audit(
  trx: Trx,
  by: PlatformActor,
  tenantId: string,
  operation: string,
  input: unknown
): Promise<void> {
  await setRole(trx, 'mycel_platform');
  await recordPlatformAudit(trx, {
    id: uuidv7(),
    tenantId,
    occurredAt: new Date(),
    actorKind: 'platform',
    actorId: by.actorId,
    operation,
    effect: null,
    inputHash: await hashInput(by.hasher, input),
    result: 'ok',
    requestId: by.requestId ?? null,
    subjectId: tenantId,
  });
}

export interface SiteFontUpload {
  family: SiteFontFamilyInput;
  weight: number;
  style: SiteFontStyle;
  bytes: Uint8Array;
  /** Replace the role's family and every face it had; without it, a different name is refused. */
  replaceFamily: boolean;
}

/**
 * Add or replace one face of a role's family, with the family's name, category and licence. The
 * bytes go through `validate` (the woff2 validator of `@mycel/media-sharp`) before the
 * transaction starts, so a refused file writes nothing, not even an audit row.
 */
export async function uploadSiteFontFace(
  operatorDb: Kysely<Database>,
  tenantId: string,
  upload: SiteFontUpload,
  by: PlatformActor,
  validate: (bytes: Uint8Array) => void
): Promise<SiteFont> {
  const family = SiteFontFamilyInput.parse(upload.family);
  const weight = SiteFontWeight.parse(upload.weight);
  const style = SiteFontStyle.parse(upload.style);
  validate(upload.bytes);
  const sha256 = createHash('sha256').update(upload.bytes).digest('hex');
  return operatorDb.transaction().execute(async (trx) => {
    await enterTenant(trx, tenantId);
    // One writer per role at a time: the row lock orders two uploads to the same family.
    await trx
      .selectFrom('site_fonts')
      .select('role')
      .where('role', '=', family.role)
      .forUpdate()
      .execute();
    const [existing] = await readFonts(trx, family.role);
    checkSiteFontFace(
      existing ?? null,
      family,
      { weight, style, size: upload.bytes.length },
      upload.replaceFamily
    );
    const now = new Date();
    const row = {
      tenant_id: tenantId,
      role: family.role,
      family: family.family,
      category: family.category,
      licence_holder: family.licence.holder,
      licence_source: family.licence.source,
      licence_domains: [...new Set(family.licence.domains)],
      licence_confirmed_at: now,
      updated_at: now,
    };
    if (existing && upload.replaceFamily)
      await trx.deleteFrom('site_font_faces').where('role', '=', family.role).execute();
    await trx
      .insertInto('site_fonts')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'role']).doUpdateSet({
          family: row.family,
          category: row.category,
          licence_holder: row.licence_holder,
          licence_source: row.licence_source,
          licence_domains: row.licence_domains,
          licence_confirmed_at: row.licence_confirmed_at,
          updated_at: row.updated_at,
        })
      )
      .execute();
    await trx
      .insertInto('site_font_faces')
      .values({
        tenant_id: tenantId,
        role: family.role,
        weight,
        style,
        bytes: Buffer.from(upload.bytes),
        sha256,
      })
      .onConflict((oc) =>
        oc
          .columns(['tenant_id', 'role', 'weight', 'style'])
          .doUpdateSet({ bytes: Buffer.from(upload.bytes), sha256 })
      )
      .execute();
    const [font] = await readFonts(trx, family.role);
    await audit(trx, by, tenantId, SITE_FONT_UPLOAD, {
      family,
      weight,
      style,
      sha256,
      replaceFamily: upload.replaceFamily,
    });
    return font!;
  });
}

/**
 * Remove one face, or the whole family of a role when `face` is null; removing the last face
 * removes the family too, so a role never has a family without a file. False when there was
 * nothing to remove (and nothing is audited).
 */
export async function removeSiteFont(
  operatorDb: Kysely<Database>,
  tenantId: string,
  role: SiteFontRole,
  face: { weight: number; style: SiteFontStyle } | null,
  by: PlatformActor
): Promise<boolean> {
  return operatorDb.transaction().execute(async (trx) => {
    await enterTenant(trx, tenantId);
    let removed: bigint;
    if (face) {
      const r = await trx
        .deleteFrom('site_font_faces')
        .where('role', '=', role)
        .where('weight', '=', face.weight)
        .where('style', '=', face.style)
        .executeTakeFirst();
      removed = r.numDeletedRows;
      const left = await trx
        .selectFrom('site_font_faces')
        .select('weight')
        .where('role', '=', role)
        .executeTakeFirst();
      if (!left) await trx.deleteFrom('site_fonts').where('role', '=', role).execute();
    } else {
      const r = await trx.deleteFrom('site_fonts').where('role', '=', role).executeTakeFirst();
      removed = r.numDeletedRows;
    }
    if (removed === 0n) return false;
    await audit(trx, by, tenantId, SITE_FONT_REMOVE, { role, face });
    return true;
  });
}

/** The fonts of a tenant as the operator sees them, for `mycel fonts list`. */
export function listSiteFontsOf(
  operatorDb: Kysely<Database>,
  tenantId: string
): Promise<SiteFont[]> {
  return operatorDb.transaction().execute(async (trx) => {
    await enterTenant(trx, tenantId);
    return readFonts(trx);
  });
}
