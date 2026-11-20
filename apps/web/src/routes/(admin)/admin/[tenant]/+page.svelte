<!-- The dashboard: up to seven widgets in two columns, one on a phone (brief edit-screen § 4).
     "Visits" says whether the site measures and links to the statistics, for a site administrator
     (an empty contour for others); "Sign-ups" shows lists and campaigns of the last 30 days and
     "Gifts" the money of this month and what runs (MY-259). "Waiting work" shows the newest five of what asks
     for attention, from the layout's one `attention.list`, with a link to all of them; the bell
     reads the same list. "Recently edited" and "Scheduled"
     link to the items in the content locale. "Usage and limits" shows the usage the
     tenant home showed, with its suspended notice; the settings show the same list. -->
<script lang="ts">
  import { DashboardWidget, Notice, PageHeader } from '#lib/admin/ui/index.js';
  import UsageList from '#lib/admin/UsageList.svelte';
  import AttentionList from '#lib/admin/attention/AttentionList.svelte';
  import SignupActivity from '#lib/admin/dashboard/SignupActivity.svelte';
  import GiftSummary from '#lib/admin/dashboard/GiftSummary.svelte';
  import VisitStatus from '#lib/admin/dashboard/VisitStatus.svelte';
  import { formatWhen } from '#lib/admin/format.js';
  import { fill, ui, type UiKey } from '../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  // The admin renders on the server only (csr = false), so `now` is the moment of the request.
  const now = new Date();
  const when = (iso: string, relative: boolean) =>
    formatWhen(iso, { locale: data.locale, zone: data.timeZone, now, relative });
  const attention = $derived(typeof data.attention === 'object' ? data.attention : null);
  /** The newest few on the dashboard; the page lists them all. */
  const WAITING = 5;
  type Row = NonNullable<typeof data.content>['recent'][number];
</script>

{#snippet items(
  rows: readonly Row[],
  moment: (row: Row) => { iso: string; full: string; text: string },
  none: UiKey
)}
  {#if rows.length}
    <ul class="ui-widget-list">
      {#each rows as row (row.id)}
        {@const at = moment(row)}
        <li>
          <a href="/admin/{data.tenant.slug}/content/{row.id}"
            >{row.title || t('admin.content.untitled')}</a
          >
          <time datetime={at.iso} title={at.full}>{at.text}</time>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="ui-widget-later">{t(none)}</p>
  {/if}
{/snippet}

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
    {#if data.content}
      {@const content = data.content}
      <DashboardWidget id="dash-recent" title={t('admin.dashboard.recent')} locale={data.locale}>
        {@render items(
          content.recent,
          (row) => when(row.updated, data.dateFormat !== 'absolute'),
          'admin.dashboard.recent.none'
        )}
      </DashboardWidget>
      <DashboardWidget
        id="dash-scheduled"
        title={t('admin.dashboard.scheduled')}
        locale={data.locale}
      >
        {@render items(
          content.scheduled,
          (row) => when(row.scheduledFor ?? row.updated, false),
          'admin.dashboard.scheduled.none'
        )}
      </DashboardWidget>
    {:else}
      <DashboardWidget id="dash-recent" title={t('admin.dashboard.recent')} locale={data.locale} />
      <DashboardWidget
        id="dash-scheduled"
        title={t('admin.dashboard.scheduled')}
        locale={data.locale}
      />
    {/if}
    {#if attention}
      <DashboardWidget id="dash-waiting" title={t('admin.dashboard.waiting')} locale={data.locale}>
        {#if attention.items.length}
          <AttentionList
            items={attention.items.slice(0, WAITING)}
            base="/admin/{data.tenant.slug}"
            locale={data.locale}
            timeZone={data.timeZone}
            relative={data.dateFormat !== 'absolute'}
          />
        {:else}
          <p class="ui-widget-later">{t('admin.attention.none')}</p>
        {/if}
        <p>
          <a href="/admin/{data.tenant.slug}/meldingen"
            >{fill(t('admin.dashboard.waiting.all'), { count: attention.items.length })}</a
          >
        </p>
      </DashboardWidget>
    {:else if data.attention === 'unknown'}
      <DashboardWidget id="dash-waiting" title={t('admin.dashboard.waiting')} locale={data.locale}>
        <p class="ui-widget-later">{t('admin.attention.unknown')}</p>
      </DashboardWidget>
    {:else}
      <DashboardWidget
        id="dash-waiting"
        title={t('admin.dashboard.waiting')}
        locale={data.locale}
      />
    {/if}
    {#if data.visits}
      <DashboardWidget id="dash-visits" title={t('admin.dashboard.visits')} locale={data.locale}>
        <VisitStatus
          domain={data.visits.value.plausibleDomain}
          hostname={data.visits.primaryHostname}
          mismatch={data.visits.hostnameMismatch}
          base="/admin/{data.tenant.slug}"
          locale={data.locale}
        />
      </DashboardWidget>
    {:else}
      <DashboardWidget id="dash-visits" title={t('admin.dashboard.visits')} locale={data.locale} />
    {/if}
    {#if data.activity}
      <DashboardWidget id="dash-signups" title={t('admin.dashboard.signups')} locale={data.locale}>
        <SignupActivity
          activity={data.activity}
          base="/admin/{data.tenant.slug}"
          locale={data.locale}
          contentLocale={data.contentLocale}
        />
      </DashboardWidget>
    {:else}
      <DashboardWidget
        id="dash-signups"
        title={t('admin.dashboard.signups')}
        locale={data.locale}
      />
    {/if}
    {#if data.gifts}
      <DashboardWidget id="dash-gifts" title={t('admin.dashboard.gifts')} locale={data.locale}>
        <GiftSummary summary={data.gifts} base="/admin/{data.tenant.slug}" locale={data.locale} />
      </DashboardWidget>
    {/if}
    {#if data.usage}
      <DashboardWidget id="dash-usage" title={t('admin.dashboard.usage')} locale={data.locale}>
        <UsageList usage={data.usage} locale={data.locale} />
      </DashboardWidget>
    {:else}
      <DashboardWidget id="dash-usage" title={t('admin.dashboard.usage')} locale={data.locale} />
    {/if}
  </div>
</main>
