<!-- The dashboard's "Gifts" widget (MY-259 PR 2): per currency what came in this calendar month,
     with last month beside it and what was refunded, and how many recurring gifts and paying
     members run now. Each number links to the Donations screen that lists what it counts. A site
     takes one currency (ADR 005 rule 8), so there is usually one block; a second appears only when
     money in another currency was recorded. Rejected: bars per day as in "Sign-ups" (a few gifts
     a month make a bar chart of gaps) and a conversion to one total (no exchange rates, rule 8). -->
<script lang="ts">
  import type { DonationSummary } from '@mycel/core';
  import { formatMoney } from '../../money.js';
  import { fill, plural, ui } from '../../../i18n/index.js';

  let { summary, base, locale }: { summary: DonationSummary; base: string; locale: string } =
    $props();

  const t = $derived(ui(locale));
  const number = $derived(new Intl.NumberFormat(locale));
  const money = (minor: number, currency: string) => formatMoney(minor, currency, locale);
  const count = (key: 'admin.gifts.recurring' | 'admin.gifts.members', n: number) =>
    plural(t, key, n, { n: number.format(n) });
</script>

{#if !summary.currencies.length}
  <p class="ui-widget-later">{t('admin.gifts.none')}</p>
{/if}
{#each summary.currencies as row (row.currency)}
  <dl class="totals">
    <div>
      <dt>{t('admin.gifts.month')}</dt>
      <dd>
        <span class="total">{money(row.month.net, row.currency)}</span>
        <span class="muted"
          >{fill(t('admin.gifts.previous'), {
            amount: money(row.previousMonth.net, row.currency),
          })}</span
        >
      </dd>
    </div>
  </dl>
  <ul class="ui-widget-list">
    <li>
      <a href="{base}/donations?status=paid"
        >{plural(t, 'admin.gifts.count', row.month.gifts, {
          n: number.format(row.month.gifts),
        })}</a
      >
      {#if row.month.returned}
        <span class="muted"
          >{fill(t('admin.gifts.returned'), {
            amount: money(row.month.returned, row.currency),
          })}</span
        >
      {/if}
    </li>
  </ul>
{/each}
<ul class="ui-widget-list">
  <li>
    <a href="{base}/donations/recurring?status=active&amp;kind=donation"
      >{count('admin.gifts.recurring', summary.running.donations)}</a
    >
  </li>
  <li>
    <a href="{base}/donations/recurring?status=active&amp;kind=membership"
      >{count('admin.gifts.members', summary.running.memberships)}</a
    >
  </li>
</ul>

<style>
  .muted {
    margin: 0;
    color: var(--color-muted-fg);
  }
  .totals {
    margin: 0;
  }
  .totals dt {
    color: var(--color-muted-fg);
  }
  .totals dd {
    display: grid;
    margin: 0;
  }
  .total {
    font-size: var(--step-2);
    font-weight: 700;
    line-height: 1.1;
  }
</style>
