<!-- The menus of a site on the overview pattern: first per language what is live and where the
     draft stands (to its preview and publication), then where the draft places its menus, then the
     menus: per menu its name (to its editor), how many items it holds and where the draft shows
     it. One primary action: a new menu. Native links and plain tables; nothing needs JavaScript.
     Until the site reads this navigation a notice says so, because the old links under Settings
     are still what visitors see. -->
<script lang="ts">
  import { page } from '$app/state';
  import { formatWhen } from '#lib/admin/format.js';
  import { Button, MetaList, Notice, OverviewPage, Section, Table } from '#lib/admin/ui/index.js';
  import { fill, ui } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const title = $derived(t('admin.navigation.title'));
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      relative: data.dateFormat !== 'absolute',
    });
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
    {#if page.url.searchParams.has('restored')}<Notice tone="success"
        >{t('admin.navigation.overview.restored')}</Notice
      >{:else if page.url.searchParams.has('merged')}<Notice tone="success"
        >{t('admin.navigation.merged')}</Notice
      >{:else if page.url.searchParams.has('saved')}<Notice tone="success"
        >{t('admin.navigation.saved')}</Notice
      >{/if}
  {/snippet}
  {#snippet intro()}
    {#if data.menus.length}
      <Section
        id="navigation-publication"
        title={t('admin.navigation.publication')}
        intro={t('admin.navigation.publication.intro')}
        locale={data.locale}
      >
        <Table
          id="navigation-locales"
          caption={t('admin.navigation.publication')}
          hideCaption
          stack
          card
          columns={[
            { key: 'language', label: t('admin.navigation.column.language') },
            { key: 'live', label: t('admin.navigation.column.live') },
            { key: 'draft', label: t('admin.navigation.column.draft') },
          ]}
        >
          {#snippet rows()}
            {#each data.locales as l (l.locale)}
              <tr>
                <td data-label={t('admin.navigation.column.language')}
                  ><a
                    href="{base}/navigation/preview/{l.locale}"
                    aria-label={fill(t('admin.navigation.previewIn'), { locale: l.locale })}
                    >{l.locale}</a
                  ></td
                >
                <td data-label={t('admin.navigation.column.live')}>
                  {#if l.live}{@const w = when(l.live.publishedAt)}<time
                      datetime={w.iso}
                      title={w.full}>{w.text}</time
                    >{:else}{t('admin.navigation.live.none')}{/if}
                </td>
                <td data-label={t('admin.navigation.column.draft')}
                  >{t(`admin.navigation.draft.${l.draft}`)}</td
                >
              </tr>
            {/each}
          {/snippet}
        </Table>
        {#if data.revisions}<p>
            <a href="{base}/navigation/revisions">{t('admin.navigation.revisions.all')}</a>
          </p>{/if}
      </Section>
      <Section
        id="navigation-placements"
        title={t('admin.navigation.placements')}
        intro={t('admin.navigation.placements.intro')}
        locale={data.locale}
      >
        <MetaList
          items={data.placements.map((p) => ({
            term: t(`admin.navigation.placement.${p.key}`),
            value: p.menus.length
              ? p.menus.map((m) => m.name).join(', ')
              : t('admin.navigation.placements.none'),
          }))}
        />
        {#if data.canWrite}<Button variant="secondary" href="{base}/navigation/placements"
            >{t('admin.navigation.placements.edit')}</Button
          >{/if}
      </Section>
    {/if}
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
