<!-- The unsubscribe page: a link for a supporter still on the list shows one native form with one
     button (ADR 009: no JavaScript needed); every other state, and the answer to the post, is a
     plain message. -->
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
  {#if !form && data.unsubscribe}
    <form method="post" action={data.unsubscribe.action}>
      <input type="hidden" name="token" value={data.unsubscribe.token} />
      <button type="submit">{data.unsubscribe.label}</button>
    </form>
  {/if}
</main>
