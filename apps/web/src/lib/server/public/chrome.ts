// The site's header and footer as one model, for the public layout and the item previews alike
// (docs/architecture/content-layout.md § Site chrome), so a preview cannot drift from the
// site. Only `base` differs: a public page links within its site form, a preview under its own
// prefix, whose catch-all route sends the operator on to the public URL, as a link in the content
// already does (`withBase`, routes/(preview)/admin/[tenant]/preview/[...path]). The admin itself
// never runs on a tenant hostname (ADR 014). The footer credit follows ADR 015 rule 5 in both.
// Rejected: a preview with only the identity, whose two chrome transitions differed from the
// site's, and links without an href in the preview, a different element than the site renders.
import { anonymousPrincipal, entitled, pickAny } from '@mycel/core';
import { withBase } from '../../blocks/rich-text.js';
import type { ChromeLink, ChromeModel } from '../../components/chrome.js';
import { ui } from '../../../i18n/index.js';
import { runtime } from '../runtime.js';
import { siteTenant, type Site } from '../site.js';
import { brandPath, siteBrand, siteChrome } from './theme.js';

/** The chrome of `site` in `locale`, its site-relative links and assets under `base`. */
export async function chromeModel(
  site: Site,
  locale: string,
  base: string
): Promise<{ chrome: ChromeModel; credit: ChromeLink | null }> {
  const [chrome, brand] = await Promise.all([siteChrome(site), siteBrand(site)]);
  const fallback = site.tenant.defaultLocale;
  const link = (item: { label: Record<string, string>; href: string }): ChromeLink => ({
    label: pickAny(item.label, locale, fallback) ?? '',
    href: withBase(base, item.href),
  });
  return {
    chrome: {
      name: site.tenant.name,
      home: `${base}/`,
      logo: brand.logo.active
        ? {
            src: withBase(base, brandPath('logo', brand.logo.version)),
            width: brand.logo.width!,
            height: brand.logo.height!,
          }
        : null,
      wordmark: brand.font.active,
      navigation: chrome.navigation.map(link),
      legal: chrome.legal.map(link),
      footer: chrome.footer[locale] ?? chrome.footer[fallback] ?? '',
      support: chrome.support ? link(chrome.support) : null,
      help: chrome.help ? link(chrome.help) : null,
    },
    credit: entitled(anonymousPrincipal(siteTenant(site), []), 'remove_branding')
      ? null
      : { href: runtime().config.PLATFORM_CREDIT_URL, label: ui(locale)('credit.runsOnMycel') },
  };
}
