<!-- The confirm page: a pending link shows one native form with one button (ADR 009: no
     JavaScript needed); every other state is a plain message. A refused post (the site was
     suspended meanwhile) shows its answer in place of the page. -->
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
  {#if !form && data.confirm}
    <form method="post" action={data.confirm.action}>
      <input type="hidden" name="token" value={data.confirm.token} />
      <button type="submit">{data.confirm.label}</button>
    </form>
  {/if}
</main>
