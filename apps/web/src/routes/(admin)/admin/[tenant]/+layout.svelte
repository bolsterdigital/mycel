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
     The top holds product/collapse, site and one native account group. Account actions stay
     together above the navigation, also on phones.
     The bell sits before the account: a plain link to the notifications page with the
     number of new ones in a red dot and in its accessible name ("Notifications 3 new": the visible
     label and number first, in that order, WCAG 2.5.3); Manage gets a dot while something
     only an administrator can solve asks for attention. Both come from the one `attention.list`
     of the layout load; there is no live update, the next page shows the next count (brief § 5).
     Rejected: a live badge (polling or a stream for a handful of changes a day) and the count in
     the menu bar on a phone only (the bell is the same link at every width).
     Under the site's name, a site with more than one locale has the content locale switch (#66
     PR 4): a form that stores the choice and comes back here. An edit screen says `itemLocale`
     in its page data and switches in its own bar instead, where it saves what was typed first.
     `data-sveltekit-reload`: every link in the shell is a real navigation, also on the two hydrated
     screens. The admin's scripts run once per document and the leave warning is `beforeunload`, so
     a router carrying a click off the editor left a screen that no longer noticed changes (#145).
     Rejected: re-initialising each script per mount, which would need every script to undo its
     document listeners, for a transition this admin does not want. -->
<script lang="ts">
  import AdminScript from '#lib/admin/trusted/AdminScript.svelte';
  import { page } from '$app/state';
  import { Icon, IconSprite, LocaleSwitch, NavGroup, type IconName } from '#lib/admin/ui/index.js';
  import { navEntries } from '#lib/admin/nav.js';
  import { MANAGE_SOURCES } from '#lib/admin/attention/words.js';
  import '#lib/admin/attention/attention.css';
  import { fill, ui } from '../../../../i18n/index.js';
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

  const attention = $derived(typeof data.attention === 'object' ? data.attention : null);
  const unread = $derived(attention?.summary.unread ?? 0);
  const bellLabel = $derived(
    unread
      ? fill(t(unread === 1 ? 'admin.attention.bell.one' : 'admin.attention.bell.many'), {
          count: unread,
        })
      : undefined
  );
  const manageAsks = $derived(
    attention?.items.some((i) => MANAGE_SOURCES.includes(i.source)) ?? false
  );

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
          icon: type === 'page' ? 'panels-top-left' : 'square-pen',
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
    const site = navEntries({
      base,
      pathname: path,
      search: page.url.search,
      capabilities: data.capabilities,
      t,
    }).map((entry) => ({
      ...entry,
      attention: entry.id === 'manage' && manageAsks ? t('admin.attention.manage') : undefined,
    }));
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
<div class="admin-shell" data-sveltekit-reload>
  <aside class="admin-sidebar" aria-label={t('admin.shell.navigation')}>
    <div class="admin-sidebar-top">
      <div class="admin-product-row">
        <a class="admin-brand" href="/admin?all">{t('admin.shell.brand')}</a>
        <button type="button" class="admin-collapse" data-nav-toggle
          ><span class="admin-collapse-close"
            ><Icon name="panel-left-close" /><span>{t('admin.shell.collapse')}</span></span
          ><span class="admin-collapse-open"
            ><Icon name="panel-left-open" /><span>{t('admin.shell.expand')}</span></span
          ></button
        >
      </div>
      <a class="admin-site-name" href={base}>{data.tenant.name}</a>
      {#if data.attention !== null}
        <a
          class="admin-bell"
          href="{base}/meldingen"
          aria-current={within('meldingen') ? 'page' : undefined}
          aria-label={bellLabel}
          data-attention-bell
          ><Icon name="bell" /><span>{t('admin.attention.title')}</span>{#if unread}{' '}<small
              class="ui-attention-count">{unread}</small
            >{/if}</a
        >
      {/if}
      <details class="admin-account" open={within('profiel')}>
        <summary data-nav-expand
          ><Icon name="circle-user" /><span>{t('admin.shell.account')}</span><Icon
            name="chevron-down"
          /></summary
        >
        <div class="admin-account-actions">
          <p>{data.email}</p>
          <a href="{base}/profiel" aria-current={within('profiel') ? 'page' : undefined}
            ><Icon name="circle-user" /><span>{t('admin.nav.profile')}</span></a
          >
          <a href="/admin?all"><Icon name="arrow-left-right" /><span>{t('admin.back')}</span></a>
          <form method="post" action="/admin/logout">
            <button type="submit" class="admin-logout"
              ><Icon name="log-out" /><span>{t('admin.logout')}</span></button
            >
          </form>
        </div>
      </details>
      {#if localeSwitch}
        <form class="admin-content-locale" method="post" action="{base}/content-locale">
          <input type="hidden" name="return" value={page.url.pathname + page.url.search} />
          <p class="admin-content-locale-label">{t('admin.locale.switch')}</p>
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
    </details>
  </aside>
  <div class="admin-workspace" id="admin-main" tabindex="-1">
    {@render children()}
  </div>
</div>
