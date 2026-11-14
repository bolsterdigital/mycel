<!-- The menus of a site on the overview pattern: per menu its name (to its editor), how many
     items it holds and where the draft shows it. One primary action: a new menu. Native links and
     a plain table; nothing needs JavaScript. Until the site reads this navigation (#107 B2) a
     notice says so, because the old links under Settings are still what visitors see. -->
<script lang="ts">
  import { Button, Notice, OverviewPage, Table } from '#lib/admin/ui/index.js';
  import { ui } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const title = $derived(t('admin.navigation.title'));
</script>

<svelte:head>
  <title>{title} · {data.tenant.name} · {t('admin.title')}</title>
</svelte:head>

{#snippet create()}
  <Button href="{base}/navigation/new">{t('admin.navigation.newMenu')}</Button>
{/snippet}

<OverviewPage
  {title}
  locale={data.locale}
  breadcrumb={[{ label: data.tenant.name, href: base }, { label: title }]}
  description={t('admin.navigation.intro')}
  listTitle={t('admin.navigation.menus')}
  empty={data.menus.length
    ? undefined
    : {
        title: t('admin.navigation.empty'),
        icon: 'menu',
        body: t('admin.navigation.empty.body'),
        action: data.canWrite ? create : undefined,
      }}
>
  {#snippet notices()}
    <Notice tone="info" live={false}
      >{t('admin.navigation.notLive')}
      <a href="{base}/site?section=chrome">{t('admin.nav.menus')}</a></Notice
    >
  {/snippet}
  {#snippet actions()}
    {#if data.canWrite && data.menus.length}{@render create()}{/if}
  {/snippet}
  <Table
    id="menus"
    caption={t('admin.navigation.menus')}
    hideCaption
    stack
    card
    level
    columns={[
      { key: 'name', label: t('admin.navigation.column.name') },
      { key: 'items', label: t('admin.navigation.column.items'), numeric: true },
      { key: 'used', label: t('admin.navigation.column.used') },
    ]}
  >
    {#snippet rows()}
      {#each data.menus as menu (menu.id)}
        <tr>
          <td data-label={t('admin.navigation.column.name')}
            ><a href="{base}/navigation/{menu.id}">{menu.name}</a></td
          >
          <td class="numeric" data-label={t('admin.navigation.column.items')}>{menu.items}</td>
          <td data-label={t('admin.navigation.column.used')}>
            {menu.usedIn.length
              ? menu.usedIn.map((p) => t(`admin.navigation.placement.${p}`)).join(', ')
              : t('admin.navigation.notPlaced')}
          </td>
        </tr>
      {/each}
    {/snippet}
  </Table>
</OverviewPage>
