<!-- One tenant shell keeps site context and navigation across server-rendered admin routes.
     Native links and details keep the entire route map available without JavaScript.
     The navigation (#66 PR 1, brief edit-screen § 4): the dashboard first, then three groups with
     short labels and Lucide icons, Content, Library and Manage; a member sees only the items their
     capabilities open. On a phone it folds into one ☰ bar, closed by default; from 60rem admin.css
     shows the list whatever `open` says. Rejected: a heading "Menu" over the list, and a
     JavaScript drawer (the details element already opens, closes and is announced). -->
<script lang="ts">
  import { page } from '$app/state';
  import { Icon, IconSprite, NavGroup, type IconName } from '#lib/admin/ui/index.js';
  import { ui, type UiKey } from '../../../../i18n/index.js';
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const path = $derived(page.url.pathname);
  const within = (segment: string) =>
    path === `${base}/${segment}` || path.startsWith(`${base}/${segment}/`);
  /** Pages and articles are separate menu items (editor trial 2026-10-28): every content route
   * says which type it shows as `contentType` in its page data, the editor and writer included. */
  const contentType = $derived(
    (page.data as { contentType?: unknown }).contentType === 'article' ? 'article' : 'page'
  );
  const has = (capability: (typeof data.capabilities)[number]) =>
    data.capabilities.includes(capability) || data.capabilities.includes('tenant:admin');

  type Item = { href: string; label: string; icon: IconName; current: boolean };
  const item = (segment: string, label: UiKey, icon: IconName): Item => ({
    href: `${base}/${segment}`,
    label: t(label),
    icon,
    current: within(segment),
  });
  const groups = $derived.by(() => {
    const content: Item[] = has('content:read')
      ? (['page', 'article'] as const).map((type) => ({
          href: `${base}/content?type=${type}`,
          label: t(type === 'page' ? 'admin.content.filter.page' : 'admin.content.filter.article'),
          icon: type === 'page' ? 'file-text' : 'newspaper',
          current: within('content') && contentType === type,
        }))
      : [];
    const library: Item[] = has('media:read') ? [item('media', 'admin.nav.media', 'image')] : [];
    const manage: Item[] = [
      ...(has('content:write') ? [item('site', 'admin.nav.settings', 'settings')] : []),
      ...(has('tenant:admin')
        ? [
            item('leden', 'admin.nav.members', 'users'),
            item('domeinen', 'admin.nav.domains', 'globe'),
          ]
        : []),
      ...(has('connections:read') ? [item('connections', 'admin.nav.connections', 'plug')] : []),
      ...(has('tenant:admin')
        ? [
            item('export', 'admin.nav.export', 'download'),
            item('status', 'admin.nav.status', 'activity'),
          ]
        : []),
    ];
    return [
      { id: 'nav-content', label: t('admin.nav.group.content'), items: content },
      { id: 'nav-library', label: t('admin.nav.group.library'), items: library },
      { id: 'nav-manage', label: t('admin.nav.group.manage'), items: manage },
    ];
  });
</script>

<IconSprite />
<a class="admin-skip" href="#admin-main">{t('admin.shell.skip')}</a>
<div class="admin-shell">
  <aside class="admin-sidebar" aria-label={t('admin.shell.navigation')}>
    <div class="admin-sidebar-top">
      <a class="admin-brand" href="/admin">{t('admin.title')}</a>
      <a class="admin-site-name" href={base}>{data.tenant.name}</a>
    </div>
    <details class="admin-menu">
      <summary><Icon name="menu" />{t('admin.shell.menu')}</summary>
      <nav aria-label={t('admin.shell.navigation')}>
        <NavGroup
          id="nav-home"
          items={[
            {
              href: base,
              label: t('admin.nav.dashboard'),
              icon: 'layout-dashboard',
              current: path === base,
            },
          ]}
        />
        {#each groups as group (group.id)}
          <NavGroup id={group.id} label={group.label} items={group.items} />
        {/each}
      </nav>
      <div class="admin-sidebar-bottom">
        <a href="/admin"><Icon name="arrow-left-right" />{t('admin.back')}</a>
        <p>{data.email}</p>
        <a href="/admin/voorkeuren?return={encodeURIComponent(base)}"
          ><Icon name="sliders-horizontal" />{t('admin.preferences.title')}</a
        >
        <form method="post" action="/admin/logout">
          <button type="submit" class="secondary"><Icon name="log-out" />{t('admin.logout')}</button
          >
        </form>
      </div>
    </details>
  </aside>
  <div class="admin-workspace" id="admin-main" tabindex="-1">
    {@render children()}
  </div>
</div>
