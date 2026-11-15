// The site path of a resolved navigation target (ADR 036 rule 3), shared by the public chrome and
// the editor's preview, so the preview shows the path the site will link to. Core resolves the
// target; the path rules live here because `searchPath` is the web app's (site search).
// An anchor is a block id; the fragment is that block's element id (`blocks/anchor.ts`).
// Rejected: a path on core's resolved target, which would move the search route into core.

import { contentPath, type ResolvedTarget } from '@mycel/core';
import { blockAnchor } from '../blocks/anchor.js';
import { searchPath } from './search-path.js';

export function navigationHref(
  target: ResolvedTarget,
  locale: string,
  defaultLocale: string
): string {
  if (target.kind === 'url') return target.href;
  if (target.kind === 'system')
    return target.page === 'search'
      ? searchPath(locale, defaultLocale)
      : locale === defaultLocale
        ? '/'
        : `/${locale}`;
  const path = contentPath(target, target.locale, defaultLocale);
  return target.anchor ? `${path}#${blockAnchor(target.anchor)}` : path;
}
