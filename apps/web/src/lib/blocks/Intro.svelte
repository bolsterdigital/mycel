<!-- The lead and hero image of an item, between its title and its blocks (#86): the same markup on
     the public page and in both previews, so a preview shows what the page will. The hero is the
     page's first image and loads eagerly. -->
<script lang="ts">
  import Credit from './Credit.svelte';
  import Picture from './Picture.svelte';
  import type { RenderIntro, RenderModel } from './model.js';

  let { intro, model }: { intro: RenderIntro; model: RenderModel } = $props();
</script>

{#if intro.lead}<p class="lead">{intro.lead}</p>{/if}
{#if intro.hero}
  <figure class="block image layout-wide page-hero">
    <Picture image={intro.hero} base={model.base} sizes="(min-width: 72rem) 68rem, 100vw" eager />
    {#if intro.hero.caption || intro.hero.credit}
      <figcaption>
        {#if intro.hero.caption}{intro.hero.caption}{/if}
        {#if intro.hero.credit}<Credit
            credit={intro.hero.credit}
            photographer={model.copy.photographer}
          />{/if}
      </figcaption>
    {/if}
  </figure>
{/if}
