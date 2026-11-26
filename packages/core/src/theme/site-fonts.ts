// A site's own heading and body font (ADR 013 rule 1, amendment of 2026-11-26; MY-302): a family
// per role, uploaded as woff2 faces with the licence the uploader confirmed, served from the
// site's own hostname. An uploaded family replaces the theme's catalogue font for that role on
// the site; the catalogue font stays the fallback where the file cannot load and the face of mail
// and the share card, which cannot carry a licensed web font.
//
// Writing is a platform operation (`mycel fonts`, packages/db/src/theme/site-fonts.ts), like the
// operator erasure of ADR 035: the owner decided that for now only the platform uploads, and a
// capability cannot say that, because `tenant:admin` holds every capability. The rules both
// fronts share live here; reading is the query `site.font.list`, so the admin, the renderer and an
// agent see the same families. When clients get the upload, a use case calls these same rules.
//
// Rejected: an external font kit (Adobe Fonts, Fonts.com) as the route (a third-party request on
// every page, ADR 009 rule 4; an ADR 022 exception per site, not built), a font URL in the theme
// (the same), and a `'site'` key in the theme's font enum (mail, share card and presets would each
// need a branch for a font they cannot use).

import { z } from 'zod';
import { defineUseCase } from '../registry.js';
import { UseCaseError } from '../errors.js';
import { FONT_CATEGORIES } from './fonts.js';
import { BRAND_LIMITS } from './assets.js';

/** The audit operations of the platform's two font operations; the storage catalog names them. */
export const SITE_FONT_UPLOAD = 'platform.site.font.upload';
export const SITE_FONT_REMOVE = 'platform.site.font.remove';
export const SITE_FONT_PLATFORM_OPERATIONS: readonly string[] = [
  SITE_FONT_UPLOAD,
  SITE_FONT_REMOVE,
];

export const SiteFontRole = z.enum(['heading', 'body']);
export type SiteFontRole = z.infer<typeof SiteFontRole>;
export const SiteFontStyle = z.enum(['normal', 'italic']);
export type SiteFontStyle = z.infer<typeof SiteFontStyle>;

/** A face's weight: the CSS steps from 100 to 900. A variable font is uploaded per static face. */
export const SiteFontWeight = z
  .number()
  .int()
  .min(100)
  .max(900)
  .refine((w) => w % 100 === 0, 'site.font.weight');

/** Faces per role: four weights in roman and italic. Bounds what one page can make a visitor fetch. */
export const SITE_FONT_FACES_MAX = 8;
/** The largest face, in bytes: the wordmark's limit, checked by the same woff2 validator. */
export const SITE_FONT_FACE_MAX_BYTES = BRAND_LIMITS.font;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** A hostname the licence names, lower case ASCII; `*.` allows the subdomains of one domain. */
export const LicenceDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine((d) => {
    const labels = (d.startsWith('*.') ? d.slice(2) : d).split('.');
    return labels.length >= 2 && labels.every((l) => LABEL.test(l));
  }, 'site.font.licence.domain');

/**
 * What the uploader states about the licence. `holder` is who bought it (normally the client),
 * `source` where (a foundry or reseller), `domains` the hostnames it covers. Uploading at all is
 * the confirmation that it allows self-hosting there; the row records when.
 */
export const SiteFontLicence = z
  .object({
    holder: z.string().trim().min(1).max(200),
    source: z.string().trim().min(1).max(200),
    domains: z.array(LicenceDomain).min(1).max(20),
  })
  .strict();
export type SiteFontLicence = z.infer<typeof SiteFontLicence>;

/**
 * The family name as the admin shows it. Never written into CSS: the stylesheet names the face
 * `Mycel Site Heading` or `Mycel Site Body` (`siteFontFamily`), so this text has no grammar to
 * escape from.
 */
export const SiteFontFamilyName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\p{Cc}]+$/u, 'site.font.family');

export const SiteFontFamilyInput = z
  .object({
    role: SiteFontRole,
    family: SiteFontFamilyName,
    category: z.enum(FONT_CATEGORIES),
    licence: SiteFontLicence,
  })
  .strict();
export type SiteFontFamilyInput = z.infer<typeof SiteFontFamilyInput>;

export const SiteFontFace = z.object({
  weight: SiteFontWeight,
  style: SiteFontStyle,
  /** Hex sha256 of the bytes: the file name carries its start, so a new upload is a new URL. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
});
export type SiteFontFace = z.infer<typeof SiteFontFace>;

export const SiteFont = z.object({
  role: SiteFontRole,
  family: z.string(),
  category: z.enum(FONT_CATEGORIES),
  licence: SiteFontLicence.extend({ confirmedAt: z.string().datetime() }),
  updatedAt: z.string().datetime(),
  faces: z.array(SiteFontFace),
});
export type SiteFont = z.infer<typeof SiteFont>;

/** The CSS family a role's uploaded font is declared as; fixed text, never the uploaded name. */
export const siteFontFamily = (role: SiteFontRole): string =>
  role === 'heading' ? 'Mycel Site Heading' : 'Mycel Site Body';

/** The file name a face is served at under `/_font/`: role, weight, style and the hash start. */
export const siteFontFile = (
  role: SiteFontRole,
  face: Pick<SiteFontFace, 'weight' | 'style' | 'sha256'>
): string => `${role}-${face.weight}-${face.style}-${face.sha256.slice(0, 16)}.woff2`;

/**
 * The face of `faces` a page preloads for text at `weight`: the roman nearest to that weight (the
 * lighter one on a tie), or none without a roman. Approximates CSS font matching, which is enough
 * for a preload hint: a miss costs one fetch, never the wrong face.
 */
export function preloadFace(faces: readonly SiteFontFace[], weight: number): SiteFontFace | null {
  const romans = faces.filter((f) => f.style === 'normal');
  if (!romans.length) return null;
  return romans.reduce((best, f) =>
    Math.abs(f.weight - weight) < Math.abs(best.weight - weight) ? f : best
  );
}

/**
 * Whether adding or replacing one face keeps the role within its bounds; the platform operation
 * checks this before it writes. A different family name for an existing role is a replacement of
 * the whole family, which the caller asks for explicitly, so a typo never mixes two families.
 */
export function checkSiteFontFace(
  existing: SiteFont | null,
  input: SiteFontFamilyInput,
  face: { weight: number; style: SiteFontStyle; size: number },
  replaceFamily: boolean
): void {
  const fail = (message: string) => new UseCaseError('invalid_input', message);
  if (face.size > SITE_FONT_FACE_MAX_BYTES) throw fail('site.font.size');
  if (!SiteFontWeight.safeParse(face.weight).success) throw fail('site.font.weight');
  if (!existing || replaceFamily) return;
  if (existing.family !== input.family) throw fail('site.font.family.other');
  const kept = existing.faces.filter((f) => f.weight !== face.weight || f.style !== face.style);
  if (kept.length + 1 > SITE_FONT_FACES_MAX) throw fail('site.font.faces.max');
}

export const listSiteFonts = defineUseCase({
  name: 'site.font.list',
  kind: 'query',
  description:
    "Read this site's own uploaded heading and body fonts: family, fallback category, licence and faces. Uploading is a platform operation (`mycel fonts`).",
  requires: 'content:read',
  input: z.object({}).strict(),
  output: z.object({ fonts: z.array(SiteFont) }),
  examples: [{ input: {} }],
  handler: async (ctx) => ({ fonts: await ctx.siteFonts.list() }),
});
