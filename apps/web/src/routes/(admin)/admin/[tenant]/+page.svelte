<!-- The dashboard: six widgets in two columns, one on a phone (brief edit-screen § 4). Five are
     empty contours for now, so the place of what will come is learnt before it is filled; #82
     fills "Waiting for you", #12 visits and #39/#47 sign-ups. "Usage and limits" shows the usage
     the tenant home showed, with its suspended notice; the settings show the same list. -->
<script lang="ts">
  import { DashboardWidget, Notice, PageHeader } from '#lib/admin/ui/index.js';
  import UsageList from '#lib/admin/UsageList.svelte';
  import { ui, type UiKey } from '../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const empty: readonly [string, UiKey][] = [
    ['dash-recent', 'admin.dashboard.recent'],
    ['dash-scheduled', 'admin.dashboard.scheduled'],
    ['dash-waiting', 'admin.dashboard.waiting'],
    ['dash-visits', 'admin.dashboard.visits'],
    ['dash-signups', 'admin.dashboard.signups'],
  ];
</script>

<svelte:head>
  <title>{t('admin.dashboard.title')} · {data.tenant.name}</title>
</svelte:head>

<main class="page admin">
  <PageHeader title={data.tenant.name} locale={data.locale} />

  {#if data.usage?.status === 'suspended'}
    <Notice tone="warning">
      <p>{t('admin.suspended')}</p>
      <p><a href="/admin/{data.tenant.slug}/export">{t('admin.suspended.export')}</a></p>
    </Notice>
  {/if}

  <div class="ui-dashboard">
    {#each empty as [id, title] (id)}
      <DashboardWidget {id} title={t(title)} locale={data.locale} />
    {/each}
    {#if data.usage}
      <DashboardWidget id="dash-usage" title={t('admin.dashboard.usage')} locale={data.locale}>
        <UsageList usage={data.usage} locale={data.locale} />
      </DashboardWidget>
    {:else}
      <DashboardWidget id="dash-usage" title={t('admin.dashboard.usage')} locale={data.locale} />
    {/if}
  </div>
</main>
