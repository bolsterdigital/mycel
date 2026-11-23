// Tenant-owned appearance and chrome (ADR 002, 013). A single repository port keeps both
// versioned documents under the same RLS boundary. Rejected: storing CSS or script strings,
// which would bypass the validated theme and CSP contracts.
import { planShareCardWalk } from '../content/published/share-card.js';
import { z } from 'zod';
import { defineUseCase } from '../registry.js';
import { UseCaseError } from '../errors.js';
import { Theme } from './contrast.js';
import './ports.js';
import {
  Palette,
  CAPTION_FONTS,
  CHROME_ROLES,
  DROP_CAPS,
  PAGE_TRANSITION_CHOICES,
  HEADING_WEIGHTS,
  THEME_VERSION,
} from './model.js';
import { DEFAULT_THEME } from './presets.js';
import { FONT_KEYS } from './fonts.js';
import { DEFAULT_TIME_ZONE, IanaTimeZone } from '../util/time-zone.js';
import { imageIssue } from '../content/service.js';
import '../media/ports.js';
import { SiteRetention } from '../ops/retention.js';
import { AiUse } from './ai-use.js';

const Footer = z.record(z.string().min(2).max(12), z.string().trim().max(500));
/** A site-relative path or an `https:` URL; site navigation targets share it (ADR 036 rule 3). */
export const SiteHref = z
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
/**
 * The networks a site can link its own profiles to (MY-273), in the order the footer shows them:
 * Dreamkit's organisation settings plus Threads. A closed list, so every one has an icon and a
 * name; a network that is missing is one line here and one icon. Rejected: free label and URL
 * pairs, which give no icon and let the footer turn into a second menu.
 */
export const SOCIAL_NETWORKS = [
  'bluesky',
  'mastodon',
  'instagram',
  'facebook',
  'linkedin',
  'youtube',
  'tiktok',
  'x',
  'whatsapp',
  'threads',
  'email',
  'website',
] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];
// An `https:` URL without credentials; e-mail is a `mailto:` with one address and nothing else.
const profileUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'site.chrome.social.invalid');
const mailto = z
  .string()
  .trim()
  .max(330)
  .regex(/^mailto:[^\s@?&,;:/]+@[^\s@?&,;:/]+\.[^\s@?&,;:/]+$/i, 'site.chrome.social.invalid');
const SocialProfiles = z
  .object(
    Object.fromEntries(
      SOCIAL_NETWORKS.map((n) => [n, (n === 'email' ? mailto : profileUrl).optional()])
    ) as Record<SocialNetwork, z.ZodOptional<typeof profileUrl>>
  )
  .strict();
export type SocialProfiles = z.infer<typeof SocialProfiles>;

/**
 * The site chrome keeps the footer text, whether the logo carries the name and the site's social
 * profiles. Menus live in the navigation document (ADR 036);
 * migration 0057 removed the old `navigation`, `legal`, `support` and `help` fields without moving
 * them (rule 10 as amended 2026-11-15: no production sites yet, so no compatibility). The strict
 * schema refuses them, so this setter, which writes live with `content:write`, can never bypass
 * the navigation's publication. Rejected: accepting and ignoring the old fields, which would let
 * an old client believe it changed the menu.
 */
export const SiteChrome = z
  .object({
    footer: Footer,
    // The logo already carries the site's name (MY-275): the header shows the logo alone and the
    // name stays the link's accessible name. Absent is false; it matters only with a logo.
    logoHasName: z.boolean().optional(),
    // The site's own profiles (MY-273), shown in the footer as icons; absent or empty shows none.
    social: SocialProfiles.optional(),
  })
  .strict();
export type SiteChrome = z.infer<typeof SiteChrome>;
export const DEFAULT_CHROME: SiteChrome = { footer: {} };
/**
 * The general settings of a site (#88): today its time zone, in which the admin plans and
 * labels times unless an operator chose their own. A document like theme and chrome, so the next
 * general setting needs no new use case.
 */
export const SiteGeneral = z
  .object({
    timeZone: IanaTimeZone,
    personPages: z.enum(['auto', 'off']).optional(),
    // Which machine uses the site reserves; absent is `open` (`ai-use.ts`).
    aiUse: AiUse.optional(),
  })
  .strict();
export type SiteGeneral = z.infer<typeof SiteGeneral>;
export const DEFAULT_GENERAL: SiteGeneral = { timeZone: DEFAULT_TIME_ZONE };
/**
 * The images of a site (#86): today its default image, the last link of an item's featured and
 * share image chain (`content/header/effective.ts`). A document of its own, not part of `general`, so the
 * Huisstijl form that sets it and the general form that sets the time zone never post over each
 * other's value. Rejected: a field on the theme, which is validated design values and is posted
 * whole by a form that knows nothing of media.
 */
export const SiteImages = z
  .object({
    defaultImageId: z.string().guid().nullable(),
    // The work shown and its maker (the CIIIC lesson) as a credit of its own. Off by
    // default: for an ordinary campaign site it is a pair of fields nobody fills in. Off hides the
    // fields in the admin; a stored work credit still renders, so turning it off loses nothing.
    workCredits: z.boolean().default(false),
  })
  .strict();
export type SiteImages = z.infer<typeof SiteImages>;
export const DEFAULT_IMAGES: SiteImages = { defaultImageId: null, workCredits: false };
/** The `media_usages` ref of the site's images: a default image counts as used. */
export const SITE_IMAGES_REF = 'site:images';
const version = z.number().int().nonnegative();
const ResolvedTheme = z
  .object({
    version: z.literal(THEME_VERSION),
    palettes: z.object({ light: Palette, dark: Palette }).strict(),
    headingFont: z.enum(FONT_KEYS),
    bodyFont: z.enum(FONT_KEYS),
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
    // Optional: a theme stored before MY-269 has none and renders with transitions on.
    pageTransitions: z.enum(PAGE_TRANSITION_CHOICES).optional(),
    // Optional for the same reason: a theme stored before the choice renders its captions in body.
    captionFont: z.enum(CAPTION_FONTS).optional(),
    // Required: the reader parses a stored theme with `Theme`, which resolves an absent choice.
    chrome: z.object({ header: z.enum(CHROME_ROLES), footer: z.enum(CHROME_ROLES) }).strict(),
  })
  .strict();
const ThemeState = z.object({ version, value: ResolvedTheme });
const ChromeState = z.object({ version, value: SiteChrome });
const GeneralState = z.object({ version, value: SiteGeneral });
const ImagesState = z.object({ version, value: SiteImages });
const RetentionState = z.object({ version, value: SiteRetention });
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
  input: z.object({ baseVersion: version, theme: Theme }).strict(),
  output: ThemeState,
  examples: [{ input: { baseVersion: 0, theme: DEFAULT_THEME } }],
  handler: async (ctx, { baseVersion, theme }) => {
    const next = await ctx.siteSettings.updateTheme(baseVersion, theme);
    if (next === null) return conflict();
    await planShareCardWalk(ctx);
    return { version: next, value: theme };
  },
});
export const getSiteChrome = defineUseCase({
  name: 'site.chrome.get',
  kind: 'query',
  description:
    'Read the footer text, logo setting and social profiles of the public site; menus are `site.navigation.*`.',
  requires: 'content:read',
  input: z.object({}).strict(),
  output: ChromeState,
  examples: [{ input: {} }],
  handler: async (ctx) => ctx.siteSettings.chrome(),
});
export const updateSiteChrome = defineUseCase({
  name: 'site.chrome.update',
  kind: 'command',
  description:
    'Replace the footer text, logo setting and social profiles of the public site at a known version.',
  requires: 'content:write',
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
  description:
    'Update general settings at a known version; an omitted personPages or aiUse preserves its current choice.',
  requires: 'content:write',
  input: z.object({ baseVersion: version, general: SiteGeneral }).strict(),
  output: GeneralState,
  examples: [{ input: { baseVersion: 0, general: { timeZone: 'Europe/Berlin' } } }],
  handler: async (ctx, { baseVersion, general }) => {
    // Older clients edit only the time zone; omission must not re-enable person pages.
    general = { ...(await ctx.siteSettings.general()).value, ...general };
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
  input: z.object({ baseVersion: version, images: SiteImages }).strict(),
  output: ImagesState,
  // Clearing the default: an id must name an image of the tenant, which an empty tenant lacks.
  examples: [{ input: { baseVersion: 0, images: { defaultImageId: null, workCredits: false } } }],
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
    await planShareCardWalk(ctx);
    return { version: next, value: images };
  },
});
/**
 * How long this site keeps what visitors sent in and when its readers last signed in
 * (docs/reference/jobs.md § Retention). A document of its
 * own with its own capability: `general` is written with `content:write`, and a shorter term
 * deletes submissions, which is not an editor's decision.
 */
export const getSiteRetention = defineUseCase({
  name: 'site.retention.get',
  kind: 'query',
  description:
    'Read how many months this site keeps form submissions and how many days it keeps the sign-in events of its readers.',
  requires: 'forms:read',
  input: z.object({}).strict(),
  output: RetentionState,
  examples: [{ input: {} }],
  handler: async (ctx) => ctx.siteSettings.retention(),
});
export const updateSiteRetention = defineUseCase({
  name: 'site.retention.update',
  kind: 'command',
  description:
    'Set how many months this site keeps form submissions and how many days it keeps sign-in events of readers (0: only the last sign-in), at a known version; a shorter term deletes what is older at the next daily run.',
  requires: 'tenant:admin',
  input: z.object({ baseVersion: version, retention: SiteRetention }).strict(),
  output: RetentionState,
  examples: [
    { input: { baseVersion: 0, retention: { submissionMonths: 12, readerActivityDays: 30 } } },
  ],
  handler: async (ctx, { baseVersion, retention }) => {
    const next = await ctx.siteSettings.updateRetention(baseVersion, retention);
    if (next === null) return conflict();
    return { version: next, value: retention };
  },
});
