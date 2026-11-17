<!-- The page behind the link in the sign-in mail: one native form with one button (ADR 009).
     A refused post (the site was suspended meanwhile) shows its answer in place of the page. -->
<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const shown = $derived(form ?? data);
</script>

<svelte:head>
  <title>{shown.title}</title>
</svelte:head>

<main class="page">
  <h1>{shown.title}</h1>
  <p>{shown.body}</p>
  {#if !form && data.complete}
    <form method="post" action={data.complete.action}>
      <input type="hidden" name="token" value={data.complete.token} />
      <button type="submit">{data.complete.label}</button>
    </form>
  {/if}
</main>
