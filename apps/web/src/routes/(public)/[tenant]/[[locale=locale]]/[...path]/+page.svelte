<!-- A public page or article, or its thank-you page: the document header (`Intro`: title, the
     only h1 per ADR 004 rule 3, lead and hero image, in the order of the edit screen), then the
     blocks from the resolved model (lib/blocks); a failed form post comes back as `form`. An
     article on a site with a drop cap carries `data-drop-cap`, which base.css reads (no style
     attribute under the CSP). The head carries the canonical URL, one alternate per published locale and
     the Open Graph tags with the share image (#66). -->
<script lang="ts">
  import Blocks from '#lib/blocks/Blocks.svelte';
  import StructuredData from '#lib/components/public/StructuredData.svelte';
  import Intro from '#lib/blocks/Intro.svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  const hasProblem = $derived(!!form && (form.errors.length > 0 || !!form.message));
  // A refused post whose form the page no longer shows (ADR 033 rule 3: a campaign closed while
  // the visitor was filling it in, on its landing page or in a card): the form would have printed
  // the refusal, so the page does, above the blocks.
  const orphanMessage = $derived(
    form?.message &&
      data.view === 'item' &&
      !data.model.blocks.some(
        (b) => (b.type === 'form' || b.type === 'campaign-card') && b.form?.formId === form.formId
      )
      ? form.message
      : null
  );
</script>

<svelte:head>
  {#if data.view === 'thanks'}
    <title>{data.title}</title>
  {:else}
    <title>{hasProblem ? `${data.errorPrefix} ` : ''}{data.head.title}</title>
    {#if data.head.description}<meta name="description" content={data.head.description} />{/if}
    {#if data.head.noindex}<meta name="robots" content="noindex" />{/if}
    <link rel="canonical" href={data.head.canonical} />
    {#each data.head.alternates as alt (alt.hreflang)}
      <link rel="alternate" hreflang={alt.hreflang} href={alt.href} />
    {/each}
    <meta property="og:type" content={data.head.share.type} />
    <meta property="og:title" content={data.head.title} />
    <meta property="og:locale" content={data.head.share.locale} />
    {#each data.head.share.alternateLocales as alternate (alternate)}
      <meta property="og:locale:alternate" content={alternate} />
    {/each}
    <meta property="og:url" content={data.head.canonical} />
    {#if data.head.description}<meta
        property="og:description"
        content={data.head.description}
      />{/if}
    {#if data.head.image}
      <meta property="og:image" content={data.head.image.src} />
      <meta property="og:image:type" content={data.head.image.type} />
      <meta property="og:image:width" content={String(data.head.image.width)} />
      <meta property="og:image:height" content={String(data.head.image.height)} />
      {#if data.head.image.alt}<meta property="og:image:alt" content={data.head.image.alt} />{/if}
      <meta name="twitter:card" content="summary_large_image" />
    {:else}
      <meta name="twitter:card" content="summary" />
    {/if}
  {/if}
</svelte:head>

{#if data.view === 'item' && data.structured}<StructuredData value={data.structured} />{/if}

{#if data.view === 'thanks'}
  <main class="page">
    <h1>{data.title}</h1>
    <p>{data.message}</p>
    <p><a href={data.back.href}>{data.back.label}</a></p>
  </main>
{:else}
  <main class="page" data-drop-cap={data.dropCap ? '' : undefined}>
    <Intro intro={data.intro} model={data.model} />
    {#if orphanMessage}
      <div class="block error-summary" role="alert" aria-labelledby="summary-refused">
        <h2 id="summary-refused">{data.model.copy.summaryTitle}</h2>
        <p>{orphanMessage}</p>
      </div>
    {/if}
    <Blocks model={data.model} formState={form ?? null} eagerFirstImage={!data.intro.hero} />
  </main>
{/if}
