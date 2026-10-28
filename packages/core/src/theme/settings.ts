// Tenant-owned appearance and chrome (ADR 002, 013). A single repository port keeps both
// versioned documents under the same RLS boundary. Rejected: storing CSS or script strings,
// which would bypass the validated theme and CSP contracts.
import { z } from 'zod';
import { defineUseCase } from '../registry.js';
import { UseCaseError } from '../errors.js';
import { Theme } from './contrast.js';
import './ports.js';
import { Palette, FONT_PAIRS, HEADING_WEIGHTS, THEME_VERSION } from './model.js';
import { DEFAULT_THEME } from './presets.js';

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
  })
  .strict();
const ThemeState = z.object({ version, value: ResolvedTheme });
const ChromeState = z.object({ version, value: SiteChrome });
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
