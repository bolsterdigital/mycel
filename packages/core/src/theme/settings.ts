// Tenant-owned appearance and chrome (ADR 002, 013). A single repository port keeps both
// versioned documents under the same RLS boundary. Rejected: storing CSS or script strings,
// which would bypass the validated theme and CSP contracts.
import { z } from 'zod';
import { defineUseCase } from '../registry.js';
import { UseCaseError } from '../errors.js';
import { Theme } from './contrast.js';
import './ports.js';
import { Palette, DROP_CAPS, FONT_PAIRS, HEADING_WEIGHTS, THEME_VERSION } from './model.js';
import { DEFAULT_THEME } from './presets.js';
import { DEFAULT_TIME_ZONE, IanaTimeZone } from '../util/time-zone.js';
import { imageIssue } from '../content/service.js';
import '../media/ports.js';

const Localized = z.record(z.string().min(2).max(12), z.string().trim().min(1).max(240));
const Footer = z.record(z.string().min(2).max(12), z.string().trim().max(500));
const Href = z
  .string()
  .max(2048)
  .refine((value) => {
    if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'site.chrome.href.invalid');
const Link = z.object({ label: Localized, href: Href }).strict();
export const SiteChrome = z
  .object({
    navigation: z.array(Link).max(12),
    footer: Footer,
    legal: z.array(Link).max(8),
    support: z.object({ label: Localized, href: Href }).strict().nullable(),
    help: z.object({ label: Localized, href: Href }).strict().nullable(),
  })
  .strict();
export type SiteChrome = z.infer<typeof SiteChrome>;
export const DEFAULT_CHROME: SiteChrome = {
  navigation: [],
  footer: {},
  legal: [],
  support: null,
  help: null,
};
/**
 * The general settings of a site (#88): today its time zone, in which the admin plans and
 * labels times unless an operator chose their own. A document like theme and chrome, so the next
 * general setting needs no new use case.
 */
export const SiteGeneral = z.object({ timeZone: IanaTimeZone }).strict();
export type SiteGeneral = z.infer<typeof SiteGeneral>;
export const DEFAULT_GENERAL: SiteGeneral = { timeZone: DEFAULT_TIME_ZONE };
/**
 * The images of a site (#86): today its default image, the last link of an item's featured and
 * share image chain (`content/header/effective.ts`). A document of its own, not part of `general`, so the
 * Huisstijl form that sets it and the general form that sets the time zone never post over each
 * other's value. Rejected: a field on the theme, which is validated design values and is posted
 * whole by a form that knows nothing of media.
 */
export const SiteImages = z.object({ defaultImageId: z.string().guid().nullable() }).strict();
export type SiteImages = z.infer<typeof SiteImages>;
export const DEFAULT_IMAGES: SiteImages = { defaultImageId: null };
/** The `media_usages` ref of the site's images: a default image counts as used. */
export const SITE_IMAGES_REF = 'site:images';
const version = z.number().int().nonnegative();
const ResolvedTheme = z
  .object({
    version: z.literal(THEME_VERSION),
    palettes: z.object({ light: Palette, dark: Palette }).strict(),
    fontPair: z.enum(FONT_PAIRS),
    baseSize: z.number(),
    scaleRatio: z.number(),
    measure: z.number(),
    radius: z.number(),
    density: z.number(),
    headingWeight: z.union(
      HEADING_WEIGHTS.map((weight) => z.literal(weight)) as [
        z.ZodLiteral<400>,
        z.ZodLiteral<500>,
        z.ZodLiteral<600>,
        z.ZodLiteral<700>,
        z.ZodLiteral<800>,
      ]
    ),
    // Optional: a theme stored before #86 has none and renders as `resolveTheme` defaults it.
    dropCap: z.enum(DROP_CAPS).optional(),
  })
  .strict();
const ThemeState = z.object({ version, value: ResolvedTheme });
const ChromeState = z.object({ version, value: SiteChrome });
const GeneralState = z.object({ version, value: SiteGeneral });
const ImagesState = z.object({ version, value: SiteImages });
const conflict = () => {
  throw new UseCaseError('conflict', 'site.settings.conflict');
};
export const getSiteTheme = defineUseCase({
  name: 'site.theme.get',
  kind: 'query',
  description: 'Read the validated theme of this site.',
  requires: 'content:read',
  input: z.object({}).strict(),
  output: ThemeState,
  examples: [{ input: {} }],
  handler: async (ctx) => ctx.siteSettings.theme(),
});
export const updateSiteTheme = defineUseCase({
  name: 'site.theme.update',
  kind: 'command',
  description: 'Replace the site theme at a known version.',
  requires: 'content:write',
  authenticatedOnly: true,
  input: z.object({ baseVersion: version, theme: Theme }).strict(),
  output: ThemeState,
  examples: [{ input: { baseVersion: 0, theme: DEFAULT_THEME } }],
  handler: async (ctx, { baseVersion, theme }) => {
    const next = await ctx.siteSettings.updateTheme(baseVersion, theme);
    if (next === null) return conflict();
    return { version: next, value: theme };
  },
});
export const getSiteChrome = defineUseCase({
  name: 'site.chrome.get',
  kind: 'query',
  description: 'Read public navigation, footer and help links.',
  requires: 'content:read',
  input: z.object({}).strict(),
  output: ChromeState,
  examples: [{ input: {} }],
  handler: async (ctx) => ctx.siteSettings.chrome(),
});
export const updateSiteChrome = defineUseCase({
  name: 'site.chrome.update',
  kind: 'command',
  description: 'Replace public site chrome at a known version.',
  requires: 'content:write',
  authenticatedOnly: true,
  input: z.object({ baseVersion: version, chrome: SiteChrome }).strict(),
  output: ChromeState,
  examples: [{ input: { baseVersion: 0, chrome: DEFAULT_CHROME } }],
  handler: async (ctx, { baseVersion, chrome }) => {
    const next = await ctx.siteSettings.updateChrome(baseVersion, chrome);
    if (next === null) return conflict();
    return { version: next, value: chrome };
  },
});
export const getSiteGeneral = defineUseCase({
  name: 'site.general.get',
  kind: 'query',
  description: 'Read the general settings of this site, such as its time zone.',
  requires: 'content:read',
  input: z.object({}).strict(),
  output: GeneralState,
  examples: [{ input: {} }],
  handler: async (ctx) => ctx.siteSettings.general(),
});
export const updateSiteGeneral = defineUseCase({
  name: 'site.general.update',
  kind: 'command',
  description: 'Replace the general settings of this site at a known version.',
  requires: 'content:write',
  authenticatedOnly: true,
  input: z.object({ baseVersion: version, general: SiteGeneral }).strict(),
  output: GeneralState,
  examples: [{ input: { baseVersion: 0, general: { timeZone: 'Europe/Berlin' } } }],
  handler: async (ctx, { baseVersion, general }) => {
    const next = await ctx.siteSettings.updateGeneral(baseVersion, general);
    if (next === null) return conflict();
    return { version: next, value: general };
  },
});
export const getSiteImages = defineUseCase({
  name: 'site.image.get',
  kind: 'query',
  description: 'Read the images of this site, such as the default image items inherit.',
  requires: 'content:read',
  input: z.object({}).strict(),
  output: ImagesState,
  examples: [{ input: {} }],
  handler: async (ctx) => ctx.siteSettings.images(),
});
export const updateSiteImages = defineUseCase({
  name: 'site.image.update',
  kind: 'command',
  description:
    'Replace the images of this site at a known version; the default image must be an image in the media library.',
  requires: 'content:write',
  authenticatedOnly: true,
  input: z.object({ baseVersion: version, images: SiteImages }).strict(),
  output: ImagesState,
  // Clearing the default: an id must name an image of the tenant, which an empty tenant lacks.
  examples: [{ input: { baseVersion: 0, images: { defaultImageId: null } } }],
  handler: async (ctx, { baseVersion, images }) => {
    // The lock `media.delete` takes: the image cannot be deleted between this check and the usage.
    await ctx.media.lock();
    const id = images.defaultImageId;
    const issue = id ? await imageIssue(ctx, id, 'images.defaultImageId') : null;
    if (issue) throw new UseCaseError('invalid_input', 'the default image is not usable', [issue]);
    const next = await ctx.siteSettings.updateImages(baseVersion, images);
    if (next === null) return conflict();
    const usages = id ? [{ mediaId: id, blockId: 'default-image' }] : [];
    if ((await ctx.media.replaceUsages(SITE_IMAGES_REF, usages)) !== usages.length)
      throw new UseCaseError('invalid_input', 'the default image could not be recorded', [
        { path: 'images.defaultImageId', message: 'content.reference.media-unrecorded' },
      ]);
    return { version: next, value: images };
  },
});
