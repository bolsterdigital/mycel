<!-- The site's donations as a list (brief MY-252 PR 2): amount, status, date and who gave, on the
     shared overview pattern and stacked table, so nothing scrolls sideways at 320 CSS px. The
     filter is a plain GET form and paging is links: the page works without JavaScript. A status
     is a word, never colour alone. The filter's two actions stand in one wrapping group (skill
     ui-action-layout). -->
<script lang="ts">
  import { Actions, Badge, Button, OverviewPage, Select, Table } from '#lib/admin/ui/index.js';
  import type { PaymentStatus } from '@mycel/core';
  import { formatWhen } from '#lib/admin/format.js';
  import { formatMoney } from '#lib/money.js';
  import { ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/donations`);
  const now = new Date();
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });
  const STATUS = {
    created: 'admin.donations.status.created',
    open: 'admin.donations.status.open',
    paid: 'admin.donations.status.paid',
    failed: 'admin.donations.status.failed',
    expired: 'admin.donations.status.expired',
    refunded: 'admin.donations.status.refunded',
    charged_back: 'admin.donations.status.charged_back',
  } as const satisfies Record<PaymentStatus, UiKey>;
  const statusLabel = (s: PaymentStatus) => t(STATUS[s]);
  const tone = (s: PaymentStatus) =>
    s === 'paid' ? 'success' : s === 'open' || s === 'created' ? 'neutral' : 'warning';
</script>

<svelte:head><title>{t('admin.donations.title')} · {data.tenant.name}</title></svelte:head>
<OverviewPage
  title={t('admin.donations.title')}
  locale={data.locale}
  description={t('admin.donations.intro')}
  listTitle={t('admin.donations.title')}
  empty={data.donations.length
    ? undefined
    : {
        title: t(data.filtered ? 'admin.donations.emptyFiltered' : 'admin.donations.empty'),
        body: data.filtered ? undefined : t('admin.donations.emptyBody'),
      }}
  paging={data.paging}
>
  {#snippet filters()}<form method="get" class="ui-fields">
      <Select
        id="donations-status"
        name="status"
        label={t('admin.donations.status')}
        locale={data.locale}
        value={data.status}
        options={[
          { value: '', label: t('admin.donations.status.all') },
          ...data.filters.map((s) => ({ value: s, label: statusLabel(s) })),
        ]}
      />
      <Actions
        ><Button>{t('admin.donations.filter')}</Button><Button variant="link" href={base}
          >{t('admin.donations.clear')}</Button
        ></Actions
      >
    </form>{/snippet}
  <Table
    id="donations"
    caption={t('admin.donations.title')}
    hideCaption
    stack
    card
    columns={[
      { key: 'amount', label: t('admin.donations.amount') },
      { key: 'status', label: t('admin.donations.status') },
      { key: 'date', label: t('admin.donations.date') },
      { key: 'giver', label: t('admin.donations.giver') },
    ]}
  >
    {#snippet rows()}{#each data.donations as d (d.id)}
        {@const at = when(d.createdAt)}
        <tr
          ><th scope="row" data-label={t('admin.donations.amount')}
            >{formatMoney(d.amount, d.currency, data.locale)}</th
          >
          <td data-label={t('admin.donations.status')}
            ><Badge tone={tone(d.status)}>{statusLabel(d.status)}</Badge></td
          >
          <td data-label={t('admin.donations.date')}
            ><time datetime={at.iso} title={at.full}>{at.text}</time></td
          >
          <td data-label={t('admin.donations.giver')} class="donations-giver"
            >{#if d.email && data.linkSupporters}<a
                href="/admin/{data.tenant.slug}/supporters/{d.supporterId}">{d.email}</a
              >{:else if d.supporterId}{t('admin.donations.knownGiver')}{:else}{t(
                'admin.donations.noGiver'
              )}{/if}</td
          ></tr
        >
      {/each}{/snippet}
  </Table>
</OverviewPage>

<style>
  .donations-giver {
    overflow-wrap: anywhere;
  }
</style>
