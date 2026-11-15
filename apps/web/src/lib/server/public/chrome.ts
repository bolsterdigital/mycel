// The site's header and footer as one model, for the public layout and the item previews alike
// (docs/architecture/content-layout.md § Site chrome), so a preview cannot drift from the
// site. Only `base` differs: a public page links within its site form, a preview under its own
// prefix, whose catch-all route sends the operator on to the public URL, as a link in the content
// already does (`withBase`, routes/(preview)/admin/[tenant]/preview/[...path]). The admin itself
// never runs on a tenant hostname (ADR 014). The footer credit follows ADR 015 rule 5 in both.
// Rejected: a preview with only the identity, whose two chrome transitions differed from the
// site's, and links without an href in the preview, a different element than the site renders.
//
// The menus come from the published navigation document (ADR 036, migration 0057), resolved in one
// locale with no implicit fallback (rule 10): a link without a label in this locale is not there.
// They keep their two levels here; which top-level links the measured bar shows is step D2's.
import { anonymousPrincipal, entitled } from '@mycel/core';
import { withBase } from '../../blocks/rich-text.js';
import type { ChromeLink, ChromeModel, ChromeNode } from '../../components/chrome.js';
import { navigationHref } from '../../public/navigation-href.js';
import { ui } from '../../../i18n/index.js';
import { runtime } from '../runtime.js';
import { siteTenant, type Site } from '../site.js';
import { brandPath, siteBrand, siteChrome, siteNavigation, type SiteNavigation } from './theme.js';

type ResolvedLink = SiteNavigation['actions'][number];
type ResolvedNode = NonNullable<SiteNavigation['main']>['nodes'][number];

/** The chrome of `site` in `locale`, its site-relative links and assets under `base`. */
export async function chromeModel(
  site: Site,
  locale: string,
  base: string
): Promise<{ chrome: ChromeModel; credit: ChromeLink | null }> {
  const [chrome, brand, navigation] = await Promise.all([
    siteChrome(site),
    siteBrand(site),
    siteNavigation(site, locale),
  ]);
  const fallback = site.tenant.defaultLocale;
  const t = ui(locale);
  const link = (l: ResolvedLink): ChromeLink => ({
    label:
      l.label ??
      t(
        l.target.kind === 'system' && l.target.page === 'search'
          ? 'public.navigation.search'
          : 'public.navigation.home'
      ),
    href: withBase(base, navigationHref(l.target, locale, fallback)),
  });
  const tree = (nodes: ResolvedNode[]): ChromeNode[] =>
    nodes.map((n) =>
      n.kind === 'link'
        ? { kind: 'link', ...link(n), children: n.children.map(link) }
        : { kind: 'group', label: n.label, children: n.children.map(link) }
    );
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
      main: tree(navigation.main?.nodes ?? []),
      actions: navigation.actions.map(link),
      footer: chrome.footer[locale] ?? chrome.footer[fallback] ?? '',
      columns: navigation.footer.map((c) => ({ title: c.title, nodes: tree(c.nodes) })),
      legal: tree(navigation.legal?.nodes ?? []),
    },
    credit: entitled(anonymousPrincipal(siteTenant(site), []), 'remove_branding')
      ? null
      : { href: runtime().config.PLATFORM_CREDIT_URL, label: ui(locale)('credit.runsOnMycel') },
  };
}
