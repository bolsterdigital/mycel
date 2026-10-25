<!-- The content list (TODO #11 A1): a filter between pages and articles, one card per item with
     its status per locale, and links to edit it or start a new one. Links only, no actions to
     post, so it works without JavaScript; the filter is a list of links that wraps. -->
<script lang="ts">
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/content`);
  const status = (s: string) => t(`admin.content.status.${s}` as UiKey);
</script>

<svelte:head>
  <title>{t('admin.content.title')} · {data.tenant.name} · {t('admin.title')}</title>
</svelte:head>

<main class="page admin">
  <h1>{t('admin.content.title')}</h1>
  <p>
    <a href="/admin/{data.tenant.slug}"
      >{fill(t('admin.content.back'), { site: data.tenant.name })}</a
    >
  </p>

  <nav aria-label={t('admin.content.filter.label')}>
    <ul class="actions filter">
      {#each ['page', 'article'] as const as type (type)}
        <li>
          <a
            class="button"
            class:secondary={data.type !== type}
            href="{base}?type={type}"
            aria-current={data.type === type ? 'page' : undefined}
            >{t(type === 'page' ? 'admin.content.filter.page' : 'admin.content.filter.article')}</a
          >
        </li>
      {/each}
    </ul>
  </nav>

  <p><a class="button" href="{base}/new?type={data.type}">{t('admin.content.new')}</a></p>

  {#if data.items.length === 0}
    <p>{t('admin.content.empty')}</p>
  {/if}
  <ul class="content-list">
    {#each data.items as item (item.id)}
      <li class="card">
        <h2><a href="{base}/{item.id}">{item.title || t('admin.content.untitled')}</a></h2>
        <p class="muted">/{item.slug} · {t('admin.content.updated')} {item.updated}</p>
        <ul class="tags">
          {#each item.publication as p (p.locale)}
            <li>
              {p.locale}: {status(p.status)}{#if p.changes}, {t(
                  'admin.content.status.changes'
                )}{/if}
            </li>
          {/each}
        </ul>
      </li>
    {/each}
  </ul>
  {#if data.next}
    <p><a href="{base}?type={data.type}&after={data.next}">{t('admin.content.more')}</a></p>
  {/if}
</main>
