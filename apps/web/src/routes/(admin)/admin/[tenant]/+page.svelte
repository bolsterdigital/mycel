<!-- The dashboard: six widgets in two columns, one on a phone (brief edit-screen § 4). Five are
     empty contours for now, so the place of what will come is learnt before it is filled; #82
     fills "Waiting for you", #12 visits and #39/#47 sign-ups. "Usage and limits" shows the usage
     the tenant home showed, with its suspended notice. -->
<script lang="ts">
  import { DashboardWidget, MetaList, Notice, PageHeader } from '#lib/admin/ui/index.js';
  import { fill, ui, type UiKey } from '../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const number = $derived(new Intl.NumberFormat(data.locale));
  const of = (used: number | string, max: number | string) =>
    fill(t('admin.usage.of'), {
      used: typeof used === 'number' ? number.format(used) : used,
      max: typeof max === 'number' ? number.format(max) : max,
    });
  const bytes = (n: number) =>
    new Intl.NumberFormat(data.locale, {
      style: 'unit',
      unit: n >= 1024 ** 3 ? 'gigabyte' : 'megabyte',
      maximumFractionDigits: 1,
    }).format(n / (n >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2));
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
      {@const usage = data.usage}
      <DashboardWidget id="dash-usage" title={t('admin.dashboard.usage')} locale={data.locale}>
        <MetaList
          items={[
            {
              term: t('admin.usage.supporters'),
              value: of(usage.supporters.used, usage.supporters.max),
            },
            { term: t('admin.usage.mail'), value: of(usage.mail.usedThisMonth, usage.mail.max) },
            {
              term: t('admin.usage.storage'),
              value: of(bytes(usage.storage.usedBytes), bytes(usage.storage.maxBytes)),
            },
            {
              term: t('admin.usage.operators'),
              value: of(usage.operators.used, usage.operators.max),
            },
            {
              term: t('admin.usage.customDomains'),
              value: of(usage.customDomains.used, usage.customDomains.max),
            },
          ]}
        />
      </DashboardWidget>
    {:else}
      <DashboardWidget id="dash-usage" title={t('admin.dashboard.usage')} locale={data.locale} />
    {/if}
  </div>
</main>
