// The admin's menu as data (TODO #114, brief admin-navigation § Besluiten): one file says which
// screen sits where, under which label and for which capability, and the shell only renders it.
// Two entries hold the rarer screens: Manage (who and what runs the site: team, domains,
// connections, status) and Settings (how the site looks and works). Each lists its screens under
// it while you are inside; Manage always shows Team, the one screen there a site uses weekly
// (Jaap 2026-10-31: Team its own line in the main menu). Addresses do not move: API access, AI
// assistance and usage stay sections of `/site`, they only appear under Manage.
// Rejected: sections named by each screen's page data (the menu could not show a screen's place
// before you opened it, and two screens could each claim the same section), and one Settings
// entry with four groups (Jaap: "een lijst met gebruikers zijn geen instellingen").
import type { UiKey } from '../../i18n/index.js';
import type { IconName } from './ui/icons.js';

/** The capabilities the shell knows of; `tenant:admin` opens every screen. */
export type NavCapability =
  'content:read' | 'content:write' | 'media:read' | 'connections:read' | 'tenant:admin';

/** One screen: where it lives, under which label, for whom. */
export interface NavScreen {
  /** Path below `/admin/<tenant>/`, with a `?section=` when the screen is a section of a page. */
  path: string;
  label: UiKey;
  needs: NavCapability;
  /** One sentence for an overview page: what you do there. */
  hint: UiKey;
  /** Shown under its entry even while you are elsewhere. */
  always?: boolean;
}

/** An entry that opens a list of screens. */
export interface NavSection {
  id: 'manage' | 'settings';
  label: UiKey;
  icon: IconName;
  /** Where the entry itself leads. */
  path: string;
  screens: readonly NavScreen[];
}

export const MANAGE: NavSection = {
  id: 'manage',
  label: 'admin.nav.manage',
  icon: 'shield',
  path: 'beheer',
  screens: [
    {
      path: 'leden',
      label: 'admin.nav.members',
      needs: 'tenant:admin',
      hint: 'admin.manage.hint.members',
      always: true,
    },
    {
      path: 'domeinen',
      label: 'admin.nav.domains',
      needs: 'tenant:admin',
      hint: 'admin.manage.hint.domains',
    },
    {
      path: 'connections',
      label: 'admin.nav.connections',
      needs: 'connections:read',
      hint: 'admin.manage.hint.connections',
    },
    {
      path: 'site?section=api',
      label: 'admin.access.title',
      needs: 'tenant:admin',
      hint: 'admin.manage.hint.api',
    },
    {
      path: 'site?section=assist',
      label: 'admin.nav.assist',
      needs: 'tenant:admin',
      hint: 'admin.manage.hint.assist',
    },
    {
      path: 'site?section=usage',
      label: 'admin.dashboard.usage',
      needs: 'tenant:admin',
      hint: 'admin.manage.hint.usage',
    },
    {
      path: 'status',
      label: 'admin.nav.status',
      needs: 'tenant:admin',
      hint: 'admin.manage.hint.status',
    },
    {
      path: 'status/audit',
      label: 'admin.audit.title',
      needs: 'tenant:admin',
      hint: 'admin.manage.hint.audit',
    },
    {
      path: 'export',
      label: 'admin.nav.export',
      needs: 'tenant:admin',
      hint: 'admin.manage.hint.export',
    },
  ],
};

export const SETTINGS: NavSection = {
  id: 'settings',
  label: 'admin.nav.settings',
  icon: 'settings',
  path: 'site',
  screens: [
    {
      path: 'site',
      label: 'admin.site.general',
      needs: 'content:write',
      hint: 'admin.manage.hint.general',
    },
    {
      path: 'site?section=theme',
      label: 'admin.site.theme',
      needs: 'content:write',
      hint: 'admin.manage.hint.theme',
    },
    {
      path: 'site?section=brand',
      label: 'admin.site.brand',
      needs: 'content:write',
      hint: 'admin.manage.hint.brand',
    },
    {
      path: 'site?section=chrome',
      label: 'admin.nav.menus',
      needs: 'content:write',
      hint: 'admin.manage.hint.menus',
    },
  ],
};

export const SECTIONS = [MANAGE, SETTINGS] as const;

/** Whether a member with these capabilities may open a screen. */
export const opens = (capabilities: readonly string[], needs: NavCapability) =>
  capabilities.includes('tenant:admin') || capabilities.includes(needs);

/** Whether a screen is the page at `pathname` + `search` (both below the tenant's base). */
export function isScreen(screen: NavScreen, base: string, pathname: string, search: string) {
  const [path, query] = screen.path.split('?') as [string, string | undefined];
  if (pathname !== `${base}/${path}`) return false;
  const section = new URLSearchParams(search).get('section');
  if (query) return section === new URLSearchParams(query).get('section');
  // `/site` without a known section is General, as the page itself decides.
  if (path !== 'site') return true;
  return (
    !section || !SECTIONS.some((s) => s.screens.some((x) => x.path === `site?section=${section}`))
  );
}

export interface NavLink {
  href: string;
  label: string;
  current: boolean;
  hint: string;
}

export interface NavEntry {
  id: NavSection['id'];
  href: string;
  label: string;
  icon: IconName;
  current: boolean;
  children: NavLink[];
}

/**
 * The entries a member sees, with the screens to list under each: all of them while one is open
 * (or the entry's own page), otherwise only those marked `always`. An entry without a screen the
 * member may open is left out, so nobody sees an empty entry.
 */
export function navEntries(input: {
  base: string;
  pathname: string;
  search: string;
  capabilities: readonly string[];
  t: (key: UiKey) => string;
}): NavEntry[] {
  const { base, pathname, search, capabilities, t } = input;
  return SECTIONS.flatMap((section) => {
    const screens = section.screens.filter((s) => opens(capabilities, s.needs));
    if (!screens.length) return [];
    const links = screens.map((s) => ({
      href: `${base}/${s.path}`,
      label: t(s.label),
      hint: t(s.hint),
      current: isScreen(s, base, pathname, search),
      always: s.always === true,
    }));
    // An entry's own page counts only when it is not one of its screens: `/site?section=api` is
    // Manage's, though Settings leads to `/site`.
    const own =
      pathname === `${base}/${section.path}` &&
      !section.screens.some((s) => s.path === section.path);
    const inside = own || links.some((l) => l.current);
    return [
      {
        id: section.id,
        href: `${base}/${section.path}`,
        label: t(section.label),
        icon: section.icon,
        current: inside,
        children: links
          .filter((l) => inside || l.always)
          .map(({ href, label, current, hint }) => ({ href, label, current, hint })),
      },
    ];
  });
}
