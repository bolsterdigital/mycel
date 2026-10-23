<script lang="ts">
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{data.title}</title>
</svelte:head>

<main class="page">
  <h1>{data.title}</h1>
  <p>{data.body}</p>
</main>
