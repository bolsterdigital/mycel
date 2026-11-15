// The site-settings fixture of public-site.spec.ts: a bilingual site (nl, en, de) with a theme
// whose action cards walk two accents per mode, a home page, an action row, footer text and
// published menus (CHROME_FIXTURE_MENUS), plus a single-locale site. Split from the spec, which
// stood at its size limit (e2e-budget); the tests stay there.
import { THEME_PRESETS, systemPrincipal, useCases } from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { asOwner, withInvoker } from '../invoker';
import { CHROME_FIXTURE_MENUS, publishMenus } from './seed';

export const WALK = {
  light: [
    { foreground: '#ffffff', background: '#d32f2f' },
    { foreground: '#ffffff', background: '#2e7d32' },
  ],
  dark: [
    { foreground: '#ffffff', background: '#2e7d32' },
    { foreground: '#ffffff', background: '#c62828' },
  ],
};
const { light, dark } = THEME_PRESETS.editorial.palettes;
const ACCENTED = {
  ...THEME_PRESETS.editorial,
  palettes: {
    light: { ...light, cardAccents: WALK.light },
    dark: { ...dark, cardAccents: WALK.dark },
  },
};

/** Seeds both sites; the members `site-editor-<slug>@probe.test` may write content. */
export async function seedSiteSettings(
  slug: string,
  singleSlug: string,
  menus: Parameters<typeof publishMenus>[2] = CHROME_FIXTURE_MENUS
) {
  const [tenant, singleTenant] = await asOwner(async (owner) => [
    await testTenant(owner, slug, {
      name: 'Chrome fixture',
      locales: ['nl', 'en', 'de'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
    }),
    await testTenant(owner, singleSlug, {
      name: 'Single-locale fixture',
      platformDomain: process.env['PLATFORM_DOMAIN']!,
    }),
  ]);
  const [homeItemId, actiesItemId] = await withInvoker(async (invoker) => {
    const principal = systemPrincipal(tenant.id, 'e2e');
    await invoker.run(useCases.inviteMember, principal, {
      email: `site-editor-${slug}@probe.test`,
      capabilities: ['content:write', 'content:read', 'media:read', 'media:write'],
    });
    await invoker.run(useCases.inviteMember, systemPrincipal(singleTenant.id, 'e2e'), {
      email: `site-editor-${singleSlug}@probe.test`,
      capabilities: ['content:write', 'content:read'],
    });
    const { item, revision } = await invoker.run(useCases.createItem, principal, {
      slug: 'home',
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Welkom', en: 'Welcome' },
        blocks: [],
      },
    });
    for (const locale of ['nl', 'en'])
      await invoker.run(useCases.publishItem, principal, {
        itemId: item.id,
        revisionId: revision.id,
        locale,
      });
    await invoker.run(useCases.updateSiteTheme, principal, {
      baseVersion: 0,
      theme: ACCENTED,
    });
    // An action row of four filled cards walks the theme's two accents per mode.
    const row = await invoker.run(useCases.createItem, principal, {
      slug: 'acties',
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Acties' },
        blocks: [
          {
            id: 'row',
            type: 'cards',
            version: 1,
            props: {
              accent: 'filled',
              width: 'wide',
              cards: ['Een', 'Twee', 'Drie', 'Vier'].map((nl) => ({
                title: { nl },
                actions: [
                  {
                    label: { nl: `Naar ${nl}` },
                    target: { kind: 'url' as const, url: 'https://example.org/' },
                  },
                ],
              })),
            },
          },
        ],
      },
    });
    await invoker.run(useCases.publishItem, principal, {
      itemId: row.item.id,
      revisionId: row.revision.id,
      locale: 'nl',
    });
    await invoker.run(useCases.updateSiteChrome, principal, {
      baseVersion: 0,
      chrome: {
        footer: {
          nl: 'Een onafhankelijke site',
          en: 'An independent site',
          de: 'Eine unabhängige Website',
        },
      },
    });
    await publishMenus(invoker, principal, menus, ['nl', 'en', 'de']);
    const single = systemPrincipal(singleTenant.id, 'e2e');
    await invoker.run(useCases.updateSiteChrome, single, {
      baseVersion: 0,
      chrome: { footer: { nl: 'Een taal' } },
    });
    await publishMenus(invoker, single, { main: [{ href: '/home', label: { nl: 'Welkom' } }] }, [
      'nl',
    ]);
    return [item.id, row.item.id];
  });
  return { tenantId: tenant.id, singleTenantId: singleTenant.id, homeItemId, actiesItemId };
}
