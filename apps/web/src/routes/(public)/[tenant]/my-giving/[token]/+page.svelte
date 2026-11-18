<!-- The giver's gifts from the link in their mail; the gifts and their forms: OwnGifts.svelte. -->
<script lang="ts">
  import OwnGifts from '#lib/components/public/OwnGifts.svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
</script>

<svelte:head>
  <title>{data.labels.title}</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<main class="page own-gifts">
  <h1>{data.labels.title}</h1>
  {#if data.done}<p role="status">{data.done}</p>{/if}
  {#if data.suspended}
    <p>{data.labels.suspended}</p>
  {:else}
    <p>{data.labels.intro}</p>
  {/if}
  <OwnGifts
    gifts={data.gifts}
    labels={data.labels}
    action={(change) => `${data.base}/${change}`}
    failed={form && 'gift' in form ? (form as { gift: string; message: string }) : null}
  />
</main>
