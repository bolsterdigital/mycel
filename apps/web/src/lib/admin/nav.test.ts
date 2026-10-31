import { describe, expect, it } from 'vitest';
import { ui } from '../../i18n/index.js';
import { MANAGE, navEntries, SETTINGS } from './nav.js';

const t = ui('en');
const base = '/admin/probe';
const at = (url: string, capabilities: string[] = ['tenant:admin']) => {
  const u = new URL(url, 'http://x');
  return navEntries({ base, pathname: u.pathname, search: u.search, capabilities, t });
};
const labels = (entry: { children: { label: string }[] } | undefined) =>
  entry?.children.map((c) => c.label);

describe('admin navigation data (#114)', () => {
  it('shows Manage with only Team, and Settings closed, outside both', () => {
    const [manage, settings] = at(`${base}/content?type=page`);
    expect(manage).toMatchObject({ id: 'manage', label: 'Manage', current: false });
    expect(labels(manage)).toEqual(['Team']);
    expect(settings).toMatchObject({ id: 'settings', label: 'Settings', current: false });
    expect(labels(settings)).toEqual([]);
  });

  it('opens Manage with every screen on its own page and on each screen', () => {
    const all = [
      'Team',
      'Domains',
      'Connections',
      'API access',
      'AI assistance',
      'Usage and limits',
      'Status',
      'Log',
      'Export',
    ];
    expect(labels(at(`${base}/beheer`)[0])).toEqual(all);
    expect(at(`${base}/beheer`)[0]!.children.some((c) => c.current)).toBe(false);
    for (const screen of MANAGE.screens) {
      const [manage, settings] = at(`${base}/${screen.path}`);
      expect(manage!.current, screen.path).toBe(true);
      expect(manage!.children.filter((c) => c.current).map((c) => c.href)).toEqual([
        `${base}/${screen.path}`,
      ]);
      expect(settings!.current, screen.path).toBe(false);
    }
  });

  it('keeps the sections of /site apart: the look under Settings, API access under Manage', () => {
    for (const screen of SETTINGS.screens) {
      const [manage, settings] = at(`${base}/${screen.path}`);
      expect(settings!.current, screen.path).toBe(true);
      expect(labels(settings)).toEqual([
        'General',
        'Theme',
        'Logo and wordmark',
        'Menus and footer',
      ]);
      expect(manage!.current).toBe(false);
    }
    // An unknown section is General, as the settings page itself decides.
    const [, settings] = at(`${base}/site?section=nonsense`);
    expect(settings!.children.find((c) => c.current)?.label).toBe('General');
  });

  it('leaves out what a member may not open, and an entry with nothing left', () => {
    const author = at(`${base}/content`, ['content:read', 'content:write', 'media:read']);
    expect(author.map((e) => e.id)).toEqual(['settings']);
    const reader = at(`${base}/content`, ['content:read']);
    expect(reader).toEqual([]);
    const linked = at(`${base}/connections`, ['connections:read']);
    expect(linked.map((e) => e.id)).toEqual(['manage']);
    expect(labels(linked[0])).toEqual(['Connections']);
  });
});
