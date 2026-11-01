<!-- One tenant shell keeps site context and navigation across server-rendered admin routes.
     Native links and details keep the entire route map available without JavaScript.
     The navigation (#66 PR 1, brief edit-screen § 4): the dashboard first, then three groups with
     short labels and Lucide icons, Content, Library and Manage; a member sees only the items their
     capabilities open. On a phone it folds into one ☰ bar, closed by default; from 60rem admin.css
     shows the list whatever `open` says. Rejected: a heading "Menu" over the list, and a
     JavaScript drawer (the details element already opens, closes and is announced).
     From 60rem a button collapses the list to a rail of icons (#87); static/_admin/nav.js shows
     it and remembers the choice per browser, so without JavaScript there is no button and the
     list stays whole. Manage and Settings, and the screens under them, come from one data file
     (src/lib/admin/nav.ts, #114): the shell shows a screen's place before it is opened, and a
     screen knows nothing of the shell. Rejected: a rail that switches on by itself on edit
     screens (it surprises, and the script path would differ per screen; Jaap 2026-10-30).
     The top holds the site, the profile and (#118, not built yet) the notifications: what is
     about you and what asks for you, above the menu and visible on a phone too.
     Under the site's name, a site with more than one locale has the content locale switch (#66
     PR 4): a form that stores the choice and comes back here. An edit screen says `itemLocale`
     in its page data and switches in its own bar instead, where it saves what was typed first. -->
<script lang="ts">
  import AdminScript from '#lib/admin/AdminScript.svelte';
  import { page } from '$app/state';
  import { Icon, IconSprite, LocaleSwitch, NavGroup, type IconName } from '#lib/admin/ui/index.js';
  import { navEntries } from '#lib/admin/nav.js';
  import { ui } from '../../../../i18n/index.js';
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
  /** The shell's locale switch: a site with several locales, off on an edit screen. */
  const localeSwitch = $derived(
    data.tenant.locales.length > 1 && !(page.data as { itemLocale?: boolean }).itemLocale
  );
  const has = (capability: (typeof data.capabilities)[number]) =>
    data.capabilities.includes(capability) || data.capabilities.includes('tenant:admin');

  type Item = {
    href: string;
    label: string;
    icon: IconName;
    current: boolean;
    children?: readonly { label: string; href: string; current: boolean }[] | undefined;
  };
  const groups = $derived.by(() => {
    const content: Item[] = has('content:read')
      ? (['page', 'article'] as const).map((type) => ({
          href: `${base}/content?type=${type}`,
          label: t(type === 'page' ? 'admin.content.filter.page' : 'admin.content.filter.article'),
          icon: type === 'page' ? 'file-text' : 'newspaper',
          current: within('content') && contentType === type,
        }))
      : [];
    const library: Item[] = has('media:read')
      ? [
          {
            href: `${base}/media`,
            label: t('admin.nav.media'),
            icon: 'image',
            current: within('media'),
          },
        ]
      : [];
    const site: Item[] = navEntries({
      base,
      pathname: path,
      search: page.url.search,
      capabilities: data.capabilities,
      t,
    });
    return [
      { id: 'nav-content', label: t('admin.nav.group.content'), items: content },
      { id: 'nav-library', label: t('admin.nav.group.library'), items: library },
      { id: 'nav-site', label: undefined, items: site },
    ];
  });
</script>

<svelte:head>
  <AdminScript src="/_admin/nav.js" classic />
</svelte:head>

<IconSprite />
<a class="admin-skip" href="#admin-main">{t('admin.shell.skip')}</a>
<div class="admin-shell">
  <aside class="admin-sidebar" aria-label={t('admin.shell.navigation')}>
    <div class="admin-sidebar-top">
      <a class="admin-brand" href="/admin?all">{t('admin.title')}</a>
      <div class="admin-site-row">
        <a class="admin-site-name" href={base}>{data.tenant.name}</a>
        <!-- #118 puts the notifications bell here, before the profile. -->
        <a
          class="admin-profile"
          href="{base}/profiel"
          aria-current={within('profiel') ? 'page' : undefined}
          title={t('admin.nav.profile')}
          ><Icon name="circle-user" /><span class="ui-visually-hidden"
            >{t('admin.nav.profile')}</span
          ></a
        >
      </div>
      {#if localeSwitch}
        <form class="admin-content-locale" method="post" action="{base}/content-locale">
          <input type="hidden" name="return" value={page.url.pathname + page.url.search} />
          <LocaleSwitch
            label={t('admin.locale.switch')}
            locale={data.locale}
            locales={data.tenant.locales.map((l) => ({
              locale: l,
              state: 'ok' as const,
              current: l === data.contentLocale,
            }))}
          />
        </form>
      {/if}
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
        <a href="/admin?all"><Icon name="arrow-left-right" /><span>{t('admin.back')}</span></a>
        <p>{data.email}</p>
        <form method="post" action="/admin/logout">
          <button type="submit" class="admin-logout"
            ><Icon name="log-out" /><span>{t('admin.logout')}</span></button
          >
        </form>
        <button type="button" class="admin-collapse" data-nav-toggle
          ><span class="admin-collapse-close"
            ><Icon name="panel-left-close" /><span>{t('admin.shell.collapse')}</span></span
          ><span class="admin-collapse-open"
            ><Icon name="panel-left-open" /><span>{t('admin.shell.expand')}</span></span
          ></button
        >
      </div>
    </details>
  </aside>
  <div class="admin-workspace" id="admin-main" tabindex="-1">
    {@render children()}
  </div>
</div>
