<!-- The dashboard's "Visits" widget (MY-259 PR 2): whether the site measures, and where to look.
     With a Plausible site set, a link to its dashboard and what Mycel itself sends there; when that
     site no longer matches the primary hostname, a line that says so beside the link to the
     setting. Without one, the link to switch it on. Mycel reads no visitor numbers back: that would
     need a Plausible API key per site, a secret the setting does not hold, and Mycel keeps no
     history of what it sent (docs/reference/analytics.md), so the widget counts nothing itself.
     Rejected: the number of events sent (there is no record of them to count, by design). -->
<script lang="ts">
  import { PLAUSIBLE_ORIGIN } from '@mycel/core';
  import { fill, ui } from '../../../i18n/index.js';

  let {
    domain,
    hostname,
    mismatch,
    base,
    locale,
  }: {
    /** The Plausible site, or null when the site does not measure. */
    domain: string | null;
    hostname: string | null;
    mismatch: boolean;
    base: string;
    locale: string;
  } = $props();

  const t = $derived(ui(locale));
  const settings = $derived(`${base}/site#site-analytics`);
</script>

{#if domain}
  <p>{fill(t('admin.visits.on'), { domain })}</p>
  {#if mismatch && hostname}
    <p class="muted">{fill(t('admin.visits.mismatch'), { hostname })}</p>
  {/if}
  <p class="muted">{t('admin.visits.events')}</p>
  <ul class="ui-widget-list">
    <li>
      <a href="{PLAUSIBLE_ORIGIN}/{encodeURIComponent(domain)}" rel="noopener noreferrer"
        >{t('admin.visits.open')}</a
      >
    </li>
    <li><a href={settings}>{t('admin.visits.settings')}</a></li>
  </ul>
{:else}
  <p class="ui-widget-later">{t('admin.visits.off')}</p>
  <p><a href={settings}>{t('admin.visits.setUp')}</a></p>
{/if}

<style>
  p {
    margin: 0;
  }
  .muted {
    color: var(--color-muted-fg);
  }
</style>
