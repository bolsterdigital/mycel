<!-- The site's monthly and yearly gifts and memberships (MY-254 PR 2 and 4): who gives, how much
     per interval, a gift or which membership, the status, the next charge and failed charges, on the shared overview pattern and stacked table,
     so nothing scrolls sideways at 320 CSS px. The amount is the link to the gift's page. The
     filter is a plain GET form and paging is links: the page works without JavaScript. A status
     is a word, never colour alone. The filter's two actions stand in one wrapping group (skill
     ui-action-layout); the two lists of Donations are links (SubNav), not ARIA tabs. -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    OverviewPage,
    Select,
    SubNav,
    Table,
  } from '#lib/admin/ui/index.js';
  import { formatWhen } from '#lib/admin/format.js';
  import {
    donationTabs,
    givingStatus,
    givingTone,
    perInterval,
  } from '#lib/admin/donations/giving.js';
  import { ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const donations = $derived(`/admin/${data.tenant.slug}/donations`);
  const base = $derived(`${donations}/recurring`);
  const now = new Date();
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });
</script>

<svelte:head><title>{t('admin.donations.tab.recurring')} · {data.tenant.name}</title></svelte:head>
<OverviewPage
  title={t('admin.donations.title')}
  locale={data.locale}
  description={t('admin.giving.intro')}
  listTitle={t('admin.donations.tab.recurring')}
  empty={data.subscriptions.length
    ? undefined
    : {
        title: t(data.filtered ? 'admin.giving.emptyFiltered' : 'admin.giving.empty'),
        body: data.filtered ? undefined : t('admin.giving.emptyBody'),
      }}
  paging={data.paging}
>
  {#snippet intro()}<SubNav
      label={t('admin.donations.title')}
      items={donationTabs(t, donations, 'recurring')}
    />{/snippet}
  {#snippet filters()}<form method="get" class="ui-fields">
      <Select
        id="giving-status"
        name="status"
        label={t('admin.donations.status')}
        locale={data.locale}
        value={data.status}
        options={[
          { value: '', label: t('admin.donations.status.all') },
          ...data.filters.map((s) => ({ value: s, label: givingStatus(t, s) })),
        ]}
      />
      <Select
        id="giving-kind"
        name="kind"
        label={t('admin.giving.kind')}
        locale={data.locale}
        value={data.kind}
        options={[
          { value: '', label: t('admin.giving.kind.all') },
          ...data.kinds.map((k) => ({ value: k, label: t(`admin.giving.kind.${k}`) })),
        ]}
      />
      <Actions
        ><Button>{t('admin.donations.filter')}</Button><Button variant="link" href={base}
          >{t('admin.donations.clear')}</Button
        ></Actions
      >
    </form>{/snippet}
  <Table
    id="giving"
    caption={t('admin.donations.tab.recurring')}
    hideCaption
    stack
    card
    columns={[
      { key: 'amount', label: t('admin.donations.amount') },
      { key: 'kind', label: t('admin.giving.kind') },
      { key: 'status', label: t('admin.donations.status') },
      { key: 'next', label: t('admin.giving.next') },
      { key: 'failed', label: t('admin.giving.failed') },
      { key: 'giver', label: t('admin.donations.giver') },
    ]}
  >
    {#snippet rows()}{#each data.subscriptions as s (s.id)}
        <tr
          ><th scope="row" data-label={t('admin.donations.amount')}
            ><a href="{base}/{s.id}"
              >{perInterval(t, s.amount, s.currency, s.interval, data.locale)}</a
            ></th
          >
          <td data-label={t('admin.giving.kind')}
            >{s.kind === 'membership' && s.tier
              ? `${t('admin.giving.kind.membership')}: ${s.tier}`
              : t(`admin.giving.kind.${s.kind}`)}</td
          >
          <td data-label={t('admin.donations.status')}
            ><Badge tone={givingTone(s.status)}>{givingStatus(t, s.status)}</Badge></td
          >
          <td data-label={t('admin.giving.next')}
            >{#if s.nextChargeAt}{@const at = when(s.nextChargeAt)}<time
                datetime={at.iso}
                title={at.full}>{at.text}</time
              >{:else}{t('admin.giving.noNext')}{/if}</td
          >
          <td data-label={t('admin.giving.failed')}>{s.failedAttempts}</td>
          <td data-label={t('admin.donations.giver')} class="giving-giver"
            >{#if s.email && data.linkSupporters}<a
                href="/admin/{data.tenant.slug}/supporters/{s.supporterId}">{s.email}</a
              >{:else if s.supporterId}{t('admin.donations.knownGiver')}{:else}{t(
                'admin.donations.noGiver'
              )}{/if}</td
          ></tr
        >
      {/each}{/snippet}
  </Table>
</OverviewPage>

<style>
  .giving-giver {
    overflow-wrap: anywhere;
  }
</style>
