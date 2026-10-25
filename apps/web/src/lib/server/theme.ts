// Public appearance is read through the registry under the site's tenant context (ADR 002, 013).
// A request may ask for the theme and chrome from both page and layout loads: keep one promise
// per Site object so those loads cannot disagree or duplicate transactions. Rejected: process-
// global caching of tenant values, which could outlive an edit without a reliable invalidation.
import { anonymousPrincipal, useCases, type ResolvedTheme, type SiteChrome } from '@mycel/core';
import { preloadFonts, themeCss, themeHash } from '../theme/tokens.js';
import { runtime } from './runtime.js';
import { siteTenant, type Site } from './site.js';

export interface SiteTheme {
  css: string;
  hash: string;
  preload: string[];
}

const bySite = new WeakMap<Site, Promise<SiteTheme>>();
const chromeBySite = new WeakMap<Site, Promise<SiteChrome>>();
const cssCache = new Map<string, Promise<SiteTheme>>();

async function loadSiteTheme(site: Site): Promise<SiteTheme> {
  const { value: theme } = await runtime().invoker.run(
    useCases.getSiteTheme,
    anonymousPrincipal(siteTenant(site), ['content:read']),
    {}
  );
  const key = JSON.stringify(theme);
  let found = cssCache.get(key);
  if (!found) {
    const css = themeCss(theme as ResolvedTheme);
    found = themeHash(css).then((hash) => ({ css, hash, preload: preloadFonts(theme.fontPair) }));
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

/** The site-root path of the theme stylesheet; `_theme` can never be a page slug. */
export const themePath = (hash: string): string => `/_theme/${hash}.css`;
