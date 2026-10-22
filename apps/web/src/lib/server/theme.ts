// The stylesheet of a site's theme (brief #8c § 3). Until tenant themes are stored (#11) every
// site gets DEFAULT_THEME; #11 changes only `themeOf`. The CSS and its hash are computed once per
// theme and kept, because the theme is the same on every request until #11 makes it data.

import { DEFAULT_THEME, type ResolvedTheme } from '@mycel/core';
import { preloadFonts, themeCss, themeHash } from '../theme/tokens.js';
import type { Site } from './site.js';

export interface SiteTheme {
  css: string;
  hash: string;
  /** Font files the layout preloads. */
  preload: string[];
}

const cache = new WeakMap<ResolvedTheme, Promise<SiteTheme>>();

function themeOf(_site: Site): ResolvedTheme {
  return DEFAULT_THEME;
}

export function siteTheme(site: Site): Promise<SiteTheme> {
  const theme = themeOf(site);
  let found = cache.get(theme);
  if (!found) {
    const css = themeCss(theme);
    found = themeHash(css).then((hash) => ({ css, hash, preload: preloadFonts(theme.fontPair) }));
    cache.set(theme, found);
  }
  return found;
}

/** The site-root path of the theme stylesheet; `_theme` can never be a page slug. */
export const themePath = (hash: string): string => `/_theme/${hash}.css`;
