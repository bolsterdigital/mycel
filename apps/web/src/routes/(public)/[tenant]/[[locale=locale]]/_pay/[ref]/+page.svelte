<!-- The fake provider's checkout: says plainly that no money moves, and offers the three outcomes
     as buttons of one form. Once chosen, the payment is no longer open and the buttons go. -->
<script lang="ts">
  import { ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
</script>

<svelte:head>
  <title>{t('public.fakePay.title')}</title>
  <meta name="robots" content="noindex" />
</svelte:head>
<main class="page fake-pay">
  <h1>{t('public.fakePay.title')}</h1>
  <p>{t('public.fakePay.note')}</p>
  <p><strong>{data.amount}</strong> · {data.description}</p>
  {#if data.open}
    <form method="post" class="fake-pay-choices">
      {#each data.choices as choice (choice)}
        <button type="submit" name="outcome" value={choice}
          >{t(`public.fakePay.${choice}` as 'public.fakePay.paid')}</button
        >
      {/each}
    </form>
  {:else}
    <p>{t('public.fakePay.done')}</p>
  {/if}
</main>
