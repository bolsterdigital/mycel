<!-- One tenant shell keeps site context and navigation across server-rendered admin routes.
     Native links and details keep the entire route map available without JavaScript. -->
<script lang="ts">
  import { page } from '$app/state';
  import { ui } from '../../../../i18n/index.js';
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const path = $derived(page.url.pathname);
  const section = $derived(
    path.startsWith(`${base}/content`)
      ? 'content'
      : path.startsWith(`${base}/media`)
        ? 'media'
        : path.startsWith(`${base}/assist`)
          ? 'assist'
          : path.startsWith(`${base}/connections`)
            ? 'connections'
            : path.startsWith(`${base}/site`)
              ? 'site'
              : path.startsWith(`${base}/status`)
                ? 'status'
                : path.startsWith(`${base}/export`)
                  ? 'export'
                  : 'overview'
  );
  /** Pages and articles are separate menu items (editor trial 2026-10-28); a content screen says which it shows. */
  const contentType = $derived.by(() => {
    const shown = page.data as { type?: unknown; item?: { type?: unknown } };
    const type = page.url.searchParams.get('type') ?? shown.item?.type ?? shown.type;
    return type === 'article' ? 'article' : 'page';
  });
  const has = (capability: (typeof data.capabilities)[number]) =>
    data.capabilities.includes(capability) || data.capabilities.includes('tenant:admin');
</script>

<a class="admin-skip" href="#admin-main">{t('admin.shell.skip')}</a>
<div class="admin-shell">
  <aside class="admin-sidebar" aria-label={t('admin.shell.navigation')}>
    <div class="admin-sidebar-top">
      <a class="admin-brand" href="/admin">{t('admin.title')}</a>
      <p class="admin-site-name">{data.tenant.name}</p>
    </div>
    <details class="admin-menu" open>
      <summary>{t('admin.shell.menu')}</summary>
      <nav aria-label={t('admin.shell.navigation')}>
        <a href={base} aria-current={section === 'overview' ? 'page' : undefined}
          >{t('admin.shell.overview')}</a
        >
        {#if has('content:read')}
          {#each ['page', 'article'] as const as type (type)}
            <a
              href="{base}/content?type={type}"
              aria-current={section === 'content' && contentType === type ? 'page' : undefined}
              >{t(
                type === 'page' ? 'admin.content.filter.page' : 'admin.content.filter.article'
              )}</a
            >
          {/each}
        {/if}
        {#if has('media:read')}
          <a href="{base}/media" aria-current={section === 'media' ? 'page' : undefined}
            >{t('admin.media.link')}</a
          >
        {/if}
        {#if has('connections:read')}
          <a href="{base}/connections" aria-current={section === 'connections' ? 'page' : undefined}
            >{t('admin.connections.link')}</a
          >
        {/if}
        {#if has('content:write')}
          <a href="{base}/site" aria-current={section === 'site' ? 'page' : undefined}
            >{t('admin.shell.settings')}</a
          >
        {/if}
        {#if has('tenant:admin')}
          <a href="{base}/assist" aria-current={section === 'assist' ? 'page' : undefined}
            >{t('admin.assist.title')}</a
          >
          <a href="{base}/status" aria-current={section === 'status' ? 'page' : undefined}
            >{t('admin.status.link')}</a
          >
          <a href="{base}/export" aria-current={section === 'export' ? 'page' : undefined}
            >{t('admin.export.link')}</a
          >
        {/if}
      </nav>
    </details>
    <div class="admin-sidebar-bottom">
      <a href="/admin">{t('admin.back')}</a>
      <p>{data.email}</p>
      <form method="post" action="/admin/logout">
        <button type="submit" class="secondary">{t('admin.logout')}</button>
      </form>
    </div>
  </aside>
  <div class="admin-workspace" id="admin-main" tabindex="-1">
    {@render children()}
  </div>
</div>
