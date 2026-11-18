<!-- The donor's return page: one heading that says where the gift stands, the amount (for a
     monthly or yearly gift, how often it is given from now on), and the one thing to do next. On the hop from the form it sends the visitor on to the checkout at
     once (a refresh without delay, WCAG 2.2.1 allows it) and offers the same link. -->
<script lang="ts">
  import { ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const title = $derived(
    data.state === 'paid'
      ? t('public.donation.paid')
      : data.state === 'pending'
        ? t('public.donation.pending')
        : t('public.donation.failed')
  );
</script>

<svelte:head>
  <title>{data.pay ? t('public.donation.toPay') : title}</title>
  <meta name="robots" content="noindex" />
  {#if data.pay}<meta http-equiv="refresh" content="0;url={data.pay}" />{/if}
</svelte:head>
<main class="page donation-page">
  {#if data.pay}
    <h1>{t('public.donation.toPay')}</h1>
    {#if data.amount}<p>
        {t('public.donation.amount').replace('{amount}', () => data.amount!)}
      </p>{/if}
    <p><a href={data.pay}>{t('public.donation.payLink')}</a></p>
  {:else}
    <h1>{title}</h1>
    {#if data.amount && data.interval && data.state === 'paid'}<p>
        {t(`public.donation.recurring.${data.interval}`).replace('{amount}', () => data.amount!)}
      </p>
    {:else if data.amount}<p>
        {t('public.donation.amount').replace('{amount}', () => data.amount!)}
      </p>{/if}
    {#if data.state === 'paid'}
      <p>{t('public.donation.paidText')}</p>
      <p><a href={data.back}>{t('thanks.back')}</a></p>
    {:else if data.state === 'pending'}
      <p>{t('public.donation.pendingText')}</p>
      <p><a href={data.again}>{t('public.donation.again')}</a></p>
    {:else}
      <p>{t('public.donation.failedText')}</p>
      <p><a href={data.back}>{t('public.donation.retry')}</a></p>
    {/if}
  {/if}
</main>
