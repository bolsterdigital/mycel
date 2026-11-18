<!-- One monthly or yearly gift (MY-254 PR 2): the facts (amount per interval, status, giver, paid
     through, next charge, failed charges), then "Stop" in a native dialog with a plain form post,
     then its payments and its ledger, newest first, in the admin's zone. Works without
     JavaScript; sections of stacked tables, so nothing scrolls sideways at 320 CSS px; a status is
     said in words, not by colour alone. -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Dialog,
    MetaList,
    Notice,
    PageHeader,
    Section,
    Table,
  } from '#lib/admin/ui/index.js';
  import type { PaymentStatus } from '@mycel/core';
  import { formatWhen } from '#lib/admin/format.js';
  import { givingStatus, givingTone, perInterval } from '#lib/admin/donations/giving.js';
  import { formatMoney } from '#lib/money.js';
  import { refusalCopy, ui, type UiKey } from '../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const s = $derived(data.subscription);
  const amount = $derived(perInterval(t, s.amount, s.currency, s.interval, data.locale));
  const now = new Date();
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });
  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form && form.done ? form : null);
  const PAYMENT = {
    created: 'admin.donations.status.created',
    open: 'admin.donations.status.open',
    paid: 'admin.donations.status.paid',
    failed: 'admin.donations.status.failed',
    expired: 'admin.donations.status.expired',
    refunded: 'admin.donations.status.refunded',
    charged_back: 'admin.donations.status.charged_back',
  } as const satisfies Record<PaymentStatus, UiKey>;
  const paymentTone = (p: PaymentStatus) =>
    p === 'paid' ? 'success' : p === 'open' || p === 'created' ? 'neutral' : 'warning';
</script>

<svelte:head
  ><title
    >{failed ? `${t('error.prefix')} ` : ''}{amount} · {t('admin.donations.tab.recurring')} · {data
      .tenant.name}</title
  ></svelte:head
>

<main class="page admin">
  <PageHeader
    title={amount}
    locale={data.locale}
    breadcrumb={[
      { label: data.tenant.name, href: base },
      { label: t('admin.donations.title'), href: `${base}/donations` },
      { label: t('admin.donations.tab.recurring'), href: `${base}/donations/recurring` },
      { label: amount },
    ]}
    description={t('admin.giving.detail.intro')}
  />

  {#if failed}
    <Notice tone="error" title={t('error.summary.title')}><p>{refusalCopy(t, failed)}</p></Notice>
  {:else if done}
    <Notice tone="success"><p>{t(done.done)}</p></Notice>
  {/if}

  <Section id="giving-facts" title={t('admin.giving.facts')} locale={data.locale}>
    <MetaList
      items={[
        {
          term: t('admin.donations.status'),
          value: s.endReason
            ? `${givingStatus(t, s.status)}: ${t(`admin.giving.end.${s.endReason}`)}`
            : givingStatus(t, s.status),
        },
        {
          term: t('admin.donations.giver'),
          value: data.supporter
            ? data.supporter.email
            : s.supporterId
              ? t('admin.donations.knownGiver')
              : t('admin.donations.noGiver'),
        },
        ...(s.startedAt
          ? [{ term: t('admin.giving.started'), value: when(s.startedAt).full }]
          : []),
        ...(s.paidThrough
          ? [{ term: t('admin.giving.paidThrough'), value: when(s.paidThrough).full }]
          : []),
        {
          term: t('admin.giving.next'),
          value: s.nextChargeAt ? when(s.nextChargeAt).full : t('admin.giving.noNext'),
        },
        { term: t('admin.giving.failed'), value: String(s.failedAttempts) },
      ]}
    />
    {#if data.supporter}<p>
        <a href="{base}/supporters/{data.supporter.id}">{t('admin.giving.toSupporter')}</a>
      </p>{/if}
    {#if data.canStop}
      <Actions stack>
        <Dialog
          id="stop-giving"
          title={t('admin.giving.stop.title')}
          trigger={t('admin.giving.stop')}
          locale={data.locale}
        >
          <form method="post" action="?/stop" class="ui-fields">
            <p>{t('admin.giving.stop.body')}</p>
            <Actions><Button>{t('admin.giving.stop')}</Button></Actions>
          </form>
        </Dialog>
      </Actions>
    {/if}
  </Section>

  <Section id="giving-payments" title={t('admin.giving.payments')} locale={data.locale}>
    <Table
      id="giving-payments-table"
      caption={t('admin.giving.payments')}
      hideCaption
      stack
      card
      level
      columns={[
        { key: 'date', label: t('admin.donations.date') },
        { key: 'what', label: t('admin.giving.what') },
        { key: 'amount', label: t('admin.donations.amount') },
        { key: 'status', label: t('admin.donations.status') },
      ]}
    >
      {#snippet rows()}{#each data.payments as p (p.id)}
          {@const at = when(p.createdAt)}
          <tr
            ><th scope="row" data-label={t('admin.donations.date')}
              ><time datetime={at.iso} title={at.full}>{at.text}</time></th
            >
            <td data-label={t('admin.giving.what')}
              >{t(p.sequence === 'first' ? 'admin.giving.first' : 'admin.giving.charge')}</td
            >
            <td data-label={t('admin.donations.amount')}
              >{formatMoney(p.amount, p.currency, data.locale)}</td
            >
            <td data-label={t('admin.donations.status')}
              ><Badge tone={paymentTone(p.status)}>{t(PAYMENT[p.status])}</Badge></td
            ></tr
          >
        {/each}{/snippet}
    </Table>
  </Section>

  <Section id="giving-ledger" title={t('admin.giving.ledger')} locale={data.locale}>
    <Table
      id="giving-ledger-table"
      caption={t('admin.giving.ledger')}
      hideCaption
      stack
      card
      level
      columns={[
        { key: 'date', label: t('admin.donations.date') },
        { key: 'step', label: t('admin.giving.step') },
        { key: 'cause', label: t('admin.giving.cause') },
      ]}
    >
      {#snippet rows()}{#each data.ledger as e (e.id)}
          {@const at = when(e.at)}
          <tr
            ><th scope="row" data-label={t('admin.donations.date')}
              ><time datetime={at.iso} title={at.full}>{at.text}</time></th
            >
            <td data-label={t('admin.giving.step')}>{t(`admin.giving.step.${e.step}`)}</td>
            <td data-label={t('admin.giving.cause')}>{t(`admin.giving.cause.${e.cause}`)}</td></tr
          >
        {/each}{/snippet}
    </Table>
  </Section>
</main>
