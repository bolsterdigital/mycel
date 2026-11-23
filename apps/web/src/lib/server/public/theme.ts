// Public appearance is read through the registry under the site's tenant context (ADR 002, 013).
// A request may ask for the theme and chrome from both page and layout loads: keep one promise
// per Site object so those loads cannot disagree or duplicate transactions. Rejected: process-
// global caching of tenant values, which could outlive an edit without a reliable invalidation.
import {
  anonymousPrincipal,
  resolveTheme,
  useCases,
  type DropCap,
  type ResolvedTheme,
  type SiteChrome,
  type SiteGeneral,
} from '@mycel/core';
import { preloadFonts, themeCss, themeHash } from '../../theme/tokens.js';
import { runtime } from '../runtime.js';
import { siteTenant, type Site } from '../site.js';

export interface SiteTheme {
  css: string;
  hash: string;
  preload: string[];
  /** Not in the CSS: the page sets `data-drop-cap`, so the ETag digest carries it (#86). */
  dropCap: DropCap;
  /** The `body` background per mode, for the browser's `theme-color`; in the CSS hash already. */
  colors: { light: string; dark: string };
  /** Page transitions on (MY-269): the page loads the floating pairs; in the CSS hash already. */
  transitions: boolean;
}

const bySite = new WeakMap<Site, Promise<SiteTheme>>();
const chromeBySite = new WeakMap<Site, Promise<SiteChrome>>();
const generalBySite = new WeakMap<Site, Promise<SiteGeneral>>();
/** What `site.navigation.resolve` returns: the published navigation of one locale. */
export type SiteNavigation = Awaited<ReturnType<(typeof useCases.resolveNavigation)['handler']>>;
const navigationBySite = new WeakMap<Site, Map<string, Promise<SiteNavigation>>>();
const brandBySite = new WeakMap<
  Site,
  Promise<{
    logo: Awaited<ReturnType<typeof useCases.getBrandAsset.handler>>;
    font: Awaited<ReturnType<typeof useCases.getBrandAsset.handler>>;
  }>
>();
const cssCache = new Map<string, Promise<SiteTheme>>();

export function siteBrand(site: Site) {
  let found = brandBySite.get(site);
  if (!found) {
    const principal = anonymousPrincipal(siteTenant(site), ['content:read']);
    found = Promise.all([
      runtime().invoker.run(useCases.getBrandAsset, principal, { kind: 'logo' }),
      runtime().invoker.run(useCases.getBrandAsset, principal, { kind: 'font' }),
    ]).then(([logo, font]) => ({ logo, font }));
    brandBySite.set(site, found);
  }
  return found;
}
export const brandPath = (kind: 'logo' | 'font', version: number) =>
  `/_brand/${kind}/${version}.${kind === 'logo' ? 'webp' : 'woff2'}`;
/** The square icon sizes: the iOS touch icon, then the two a web app manifest names. */
export const ICON_SIZES = [180, 192, 512] as const;
/**
 * The address of a square icon of the logo on `background`: logo version and colour are in the
 * name, so a new logo or theme gets a new address and the old one may be cached forever.
 */
export const iconPath = (version: number, background: string, size: number) =>
  `/_brand/icon/${version}-${background.slice(1).toLowerCase()}-${size}.png`;

async function loadSiteTheme(site: Site): Promise<SiteTheme> {
  const { value: theme } = await runtime().invoker.run(
    useCases.getSiteTheme,
    anonymousPrincipal(siteTenant(site), ['content:read']),
    {}
  );
  const { font } = await siteBrand(site);
  const key = JSON.stringify({
    theme,
    font: font.version,
    active: font.active,
    tenant: site.tenant.id,
  });
  let found = cssCache.get(key);
  if (!found) {
    const css =
      themeCss(theme as ResolvedTheme) +
      (font.active
        ? `@font-face { font-family: 'Mycel Wordmark'; src: url('../_brand/font/${font.version}.woff2') format('woff2'); font-display: swap; }\n.site-wordmark { font-family: 'Mycel Wordmark', Inter, sans-serif; }\n`
        : '');
    const { dropCap, palettes, pageTransitions } = resolveTheme(theme);
    found = themeHash(css).then((hash) => ({
      css,
      hash,
      preload: preloadFonts(theme),
      dropCap,
      colors: { light: palettes.light.body.background, dark: palettes.dark.body.background },
      transitions: pageTransitions === 'on',
    }));
    // The cache is only an optimization for repeated themes; tenant data is read on each request.
    if (cssCache.size >= 128) cssCache.delete(cssCache.keys().next().value!);
    cssCache.set(key, found);
  }
  return found;
}

export function siteTheme(site: Site): Promise<SiteTheme> {
  let found = bySite.get(site);
  if (!found) {
    found = loadSiteTheme(site);
    bySite.set(site, found);
  }
  return found;
}

/** The general settings, read once per request like the chrome (robots.txt, TDM reservation). */
export function siteGeneral(site: Site): Promise<SiteGeneral> {
  let found = generalBySite.get(site);
  if (!found) {
    found = runtime()
      .invoker.run(
        useCases.getSiteGeneral,
        anonymousPrincipal(siteTenant(site), ['content:read']),
        {}
      )
      .then(({ value }) => value);
    generalBySite.set(site, found);
  }
  return found;
}

export function siteChrome(site: Site): Promise<SiteChrome> {
  let found = chromeBySite.get(site);
  if (!found) {
    found = runtime()
      .invoker.run(
        useCases.getSiteChrome,
        anonymousPrincipal(siteTenant(site), ['content:read']),
        {}
      )
      .then(({ value }) => value);
    chromeBySite.set(site, found);
  }
  return found;
}

/**
 * The published navigation of `site` in `locale` as visitors see it (ADR 036 rules 5 and 8), read
 * once per request like the chrome. The public layout renders it and the ETags hash it (rule 11),
 * so a republished target title or slug changes both.
 */
export function siteNavigation(site: Site, locale: string): Promise<SiteNavigation> {
  let perLocale = navigationBySite.get(site);
  if (!perLocale) {
    perLocale = new Map();
    navigationBySite.set(site, perLocale);
  }
  let found = perLocale.get(locale);
  if (!found) {
    found = runtime().invoker.run(
      useCases.resolveNavigation,
      anonymousPrincipal(siteTenant(site), ['content:read']),
      { locale }
    );
    perLocale.set(locale, found);
  }
  return found;
}

/** The site-root path of the theme stylesheet; `_theme` can never be a page slug. */
export const themePath = (hash: string): string => `/_theme/${hash}.css`;
