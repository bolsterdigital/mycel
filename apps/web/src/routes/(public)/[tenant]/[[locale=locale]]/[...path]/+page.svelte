<!-- A public page or article, or its thank-you page: the document title is the only h1 (ADR 004
     rule 3), the blocks render from the resolved model (lib/blocks), and a failed form post comes
     back as `form`. The head carries the canonical URL and one alternate per published locale. -->
<script lang="ts">
  import Blocks from '#lib/blocks/Blocks.svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  const hasProblem = $derived(!!form && (form.errors.length > 0 || !!form.message));
</script>

<svelte:head>
  {#if data.view === 'thanks'}
    <title>{data.title}</title>
  {:else}
    <title>{hasProblem ? `${data.errorPrefix} ` : ''}{data.model.title}</title>
    {#if data.head.description}<meta name="description" content={data.head.description} />{/if}
    <link rel="canonical" href={data.head.canonical} />
    {#each data.head.alternates as alt (alt.hreflang)}
      <link rel="alternate" hreflang={alt.hreflang} href={alt.href} />
    {/each}
  {/if}
</svelte:head>

<main class="page">
  {#if data.view === 'thanks'}
    <h1>{data.title}</h1>
    <p>{data.message}</p>
    <p><a href={data.back.href}>{data.back.label}</a></p>
  {:else}
    <h1>{data.model.title}</h1>
    <Blocks model={data.model} formState={form ?? null} />
  {/if}
</main>
