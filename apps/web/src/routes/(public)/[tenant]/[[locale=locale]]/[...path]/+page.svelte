<!-- A public page or article, or its thank-you page: the document header (`Intro`: title, the
     only h1 per ADR 004 rule 3, lead and hero image, in the order of the edit screen), then the
     blocks from the resolved model (lib/blocks), an article's corrections and the dossier boxes (MY-260); a failed form post comes back as `form`. A
     restricted item whose body was left out ends with the reader gate where the body would be. An
     article on a site with a drop cap carries `data-drop-cap`, which base.css reads (no style
     attribute under the CSP). The head carries the canonical URL, one alternate per published locale and
     the Open Graph tags with the share image (#66). -->
<script lang="ts">
  import Blocks from '#lib/blocks/Blocks.svelte';
  import Corrections from '#lib/components/public/Corrections.svelte';
  import StructuredData from '#lib/components/public/StructuredData.svelte';
  import CampaignLayout from '#lib/blocks/CampaignLayout.svelte';
  import Intro from '#lib/blocks/Intro.svelte';
  import Prefooter from '#lib/components/public/Prefooter.svelte';
  import DossierBox from '#lib/components/public/DossierBox.svelte';
  import ReaderGate from '#lib/components/public/ReaderGate.svelte';
  import ConsentBanner from '#lib/components/public/ConsentBanner.svelte';
  import { placeEmbeds } from '#lib/blocks/embeds.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  // Server-rendered only (`csr = false`), so the page's one value is read once.
  // svelte-ignore state_referenced_locally
  placeEmbeds(data.view === 'item' ? data.embeds : []);

  const hasProblem = $derived(!!form && (form.errors.length > 0 || !!form.message));
  // A refused post whose form the page no longer shows (ADR 033 rule 3: a campaign closed while
  // the visitor was filling it in, on its landing page or in a card): the form would have printed
  // the refusal, so the page does, above the blocks.
  const orphanMessage = $derived(
    form?.message &&
      data.view === 'item' &&
      data.model.campaign?.form?.formId !== form.formId &&
      ![...data.model.blocks, ...(data.prefooter?.model.blocks ?? [])].some(
        (b) => (b.type === 'form' || b.type === 'campaign-card') && b.form?.formId === form.formId
      )
      ? form.message
      : null
  );
</script>

<svelte:head>
  {#if data.view === 'item' && data.dropCap && data.intro.article?.initial}<script
      type="module"
      src="/_site/article-initial.js"
    ></script>{/if}
  {#if data.view === 'thanks' || data.view === 'campaign-thanks'}
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
    {#if data.pageview}<script
        defer
        src="/_site/pageview.js"
        data-endpoint={data.pageview.endpoint}
        data-domain={data.pageview.domain}
        data-url={data.pageview.url}
      ></script>{/if}
    {#if data.embeds.length > 0 || data.model.blocks.some((block) => block.type === 'video' && block.play)}<script
        defer
        src="/_site/embed.js"
      ></script>{/if}
    {#if data.consent}
      <link rel="stylesheet" href="/_site/consent.css" />
      <script
        defer
        src="/_site/consent.js"
        data-container={data.consent.container}
        data-category={data.consent.category}
        data-scripts={data.consent.scripts.join(' ')}
        data-path={data.consent.cookiePath}
      ></script>
    {/if}
  {/if}
</svelte:head>

{#if data.view === 'item' && data.structured}<StructuredData value={data.structured} />{/if}

{#if data.view === 'campaign-thanks'}
  <!-- A campaign's thank-you view (ADR 038 rule 8): its landing page's layout, the form's thanks
       as lead, the count, then share links to the landing page and the way back. -->
  <main class="page">
    <CampaignLayout
      campaign={data.model.campaign!}
      intro={{ ...data.intro, lead: data.message || null }}
      model={data.model}
      actionHeading={false}
    >
      <section class="campaign-share" aria-labelledby="campaign-share">
        <h2 id="campaign-share">{data.share.title}</h2>
        <ul>
          {#each data.share.links as link (link.href)}
            <li><a class="button secondary" href={link.href}>{link.label}</a></li>
          {/each}
        </ul>
        <p>{data.share.addressLabel}: <a href={data.share.address}>{data.share.address}</a></p>
      </section>
      <p><a href={data.back.href}>{data.back.label}</a></p>
    </CampaignLayout>
  </main>
{:else if data.view === 'thanks'}
  <main class="page">
    <h1>{data.title}</h1>
    <p>{data.message}</p>
    <p><a href={data.back.href}>{data.back.label}</a></p>
  </main>
{:else}
  {#if data.consent}<ConsentBanner consent={data.consent} />{/if}
  <main
    class="page"
    data-drop-cap={data.dropCap && !data.intro.article ? '' : undefined}
    data-measure-initial={data.dropCap && data.intro.article?.initial ? '' : undefined}
  >
    {#snippet refused()}
      {#if orphanMessage}
        <div class="block error-summary" role="alert" aria-labelledby="summary-refused">
          <h2 id="summary-refused">{data.model.copy.summaryTitle}</h2>
          <p>{orphanMessage}</p>
        </div>
      {/if}
    {/snippet}
    {#if data.model.campaign}
      <!-- A campaign's landing page (ADR 038 rule 2): the binding chooses the layout. -->
      {@render refused()}
      <CampaignLayout
        campaign={data.model.campaign}
        intro={data.intro}
        model={data.model}
        state={form ?? null}
      >
        <Blocks model={data.model} formState={form ?? null} eagerFirstImage={!data.intro.hero} />
      </CampaignLayout>
    {:else}
      <Intro intro={data.intro} model={data.model} />
      {@render refused()}
      <Blocks model={data.model} formState={form ?? null} eagerFirstImage={!data.intro.hero} />
    {/if}
    {#if data.corrections}<Corrections corrections={data.corrections} />{/if}
    {#if data.gate}<ReaderGate gate={data.gate} />{/if}
    {#if data.dossiers}<DossierBox dossiers={data.dossiers} base={data.model.base} />{/if}
  </main>
  {#if data.prefooter}<Prefooter zone={data.prefooter} formState={form ?? null} />{/if}
{/if}
