<!-- A public page: the document title is the only h1 (ADR 004 rule 3), the blocks render from
     the resolved model (lib/blocks), and a failed form post comes back as `form`. -->
<script lang="ts">
  import Blocks from '#lib/blocks/Blocks.svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  const hasProblem = $derived(!!form && (form.errors.length > 0 || !!form.message));
</script>

<svelte:head>
  <title>{hasProblem ? `${data.errorPrefix} ` : ''}{data.model.title}</title>
</svelte:head>

<main class="page">
  <h1>{data.model.title}</h1>
  <Blocks model={data.model} formState={form ?? null} />
</main>
