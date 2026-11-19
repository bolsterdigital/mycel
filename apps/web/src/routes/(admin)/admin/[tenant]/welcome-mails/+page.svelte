<!-- One row per list: whether its welcome series is on, how many steps and how many people
     started it. The list name opens the series; a list without one says so. -->
<script lang="ts">
  import { OverviewPage, Badge, Table } from '#lib/admin/ui/index.js';
  import { ui } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/welcome-mails`);
</script>

<svelte:head><title>{t('admin.welcome.title')} · {data.tenant.name}</title></svelte:head>
<OverviewPage
  title={t('admin.welcome.title')}
  description={t('admin.welcome.intro')}
  locale={data.locale}
  listTitle={t('admin.welcome.lists')}
  empty={data.rows.length ? undefined : { title: t('admin.welcome.empty') }}
>
  <Table
    id="welcome-series"
    caption={t('admin.welcome.lists')}
    hideCaption
    stack
    card
    columns={[
      { key: 'list', label: t('admin.welcome.list') },
      { key: 'state', label: t('admin.welcome.state') },
      { key: 'steps', label: t('admin.welcome.steps') },
      { key: 'started', label: t('admin.welcome.started') },
    ]}
  >
    {#snippet rows()}{#each data.rows as row (row.list)}<tr>
          <th scope="row" data-label={t('admin.welcome.list')}
            >{#if row.series || data.canSend}<a href="{base}/{row.list}">{row.label}</a
              >{:else}{row.label}{/if}</th
          >
          <td data-label={t('admin.welcome.state')}
            >{#if !row.series}{t('admin.welcome.state.none')}{:else if row.series.enabled}<Badge
                tone="success">{t('admin.welcome.state.on')}</Badge
              >{:else}<Badge>{t('admin.welcome.state.off')}</Badge>{/if}</td
          >
          <td data-label={t('admin.welcome.steps')}>{row.series?.steps ?? 0}</td>
          <td data-label={t('admin.welcome.started')}>{row.series?.started ?? 0}</td>
        </tr>{/each}{/snippet}
  </Table>
</OverviewPage>
