<!-- An item's one document header (ADR 025, brief #105): the title (the page's only h1), lead, hero
     image and an article's meta line, the same markup on the public page and in both previews, so
     a preview shows what the page will. The hero is the page's first image: it loads eagerly and
     with priority. The cover is an article's option: the title in marked lines on the validated
     primary pair, never bare text on a photo, and an arrow that is a link, so it works without a
     script. Rejected: a CSS background image, which loses alt, srcset and the LCP hint. -->
<script lang="ts">
  import Credit from './Credit.svelte';
  import Picture from './Picture.svelte';
  import { IMAGE_SIZES } from './sizes.js';
  import type { RenderIntro, RenderModel } from './model.js';

  let { intro, model }: { intro: RenderIntro; model: RenderModel } = $props();
</script>

{#snippet caption()}
  {#if intro.hero?.caption}{intro.hero.caption}{/if}
  {#if intro.hero?.credit}<Credit
      credit={intro.hero.credit}
      photographer={model.copy.photographer}
    />{/if}
{/snippet}

{#snippet lead()}
  {#if intro.lead}<p class="lead">{intro.lead}</p>{/if}
{/snippet}

{#snippet meta()}
  {#if intro.meta}
    <p class="page-meta">
      {#if intro.meta.date}<time datetime={intro.meta.date.iso}>{intro.meta.date.label}</time
        >{/if}{#if intro.meta.byline}{#if intro.meta.date}{' · '}{/if}{intro.meta
          .byline}{/if}{#if intro.meta.section}{#if intro.meta.date || intro.meta.byline}{' · '}{/if}{intro
          .meta.section}{/if}
    </p>
  {/if}
{/snippet}

{#if intro.header === 'cover' && intro.hero}
  <header class="page-cover">
    <Picture image={intro.hero} base={model.base} sizes="100vw" eager />
    <h1><span>{model.title}</span></h1>
    <a class="page-cover-arrow" href="#page-content" aria-label={model.copy.toContent}>
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
        <path
          d="M12 5v14M6 13l6 6 6-6"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </a>
  </header>
  {#if intro.hero.caption || intro.hero.credit}
    <p class="page-cover-caption">{@render caption()}</p>
  {/if}
  <div id="page-content"></div>
  {@render lead()}
  {@render meta()}
{:else}
  <h1>{model.title}</h1>
  {@render lead()}
  {#if intro.hero}
    <figure class="block image layout-wide page-hero">
      <Picture image={intro.hero} base={model.base} sizes={IMAGE_SIZES.wide} eager />
      {#if intro.hero.caption || intro.hero.credit}
        <figcaption>{@render caption()}</figcaption>
      {/if}
    </figure>
  {/if}
  {@render meta()}
  {#if !intro.hero}<hr class="page-rule" />{/if}
{/if}
