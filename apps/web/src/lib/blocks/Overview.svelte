<!-- An overview: the items the block's filter finds, read when the page is, as cards
     (image, title, summary, date) or as a list (title, date). The cards wear the campaign card's
     surface and image rules, so a site has two card styles, not three; overview.css only lays out
     the grid and the list. Each title is a link and names its card, so the image is decorative.
     With an archive the block ends in plain page links (`?p=2`), no JavaScript. An empty overview
     renders nothing. -->
<script lang="ts">
  import { BLOCK_DEPTH, headingTag } from './headings.js';
  import type { RenderBlock, RenderModel } from './model.js';
  import { withBase } from './rich-text.js';
  import Picture from './Picture.svelte';

  let {
    block,
    model,
    anchor,
    eager = false,
  }: {
    block: Extract<RenderBlock, { type: 'overview' }>;
    model: RenderModel;
    anchor?: string;
    eager?: boolean;
  } = $props();

  const copy = $derived(model.copy.overview);
  const sizes = $derived(
    block.width === 'content'
      ? '(min-width: 48rem) 20rem, 100vw'
      : '(min-width: 48rem) 24rem, 100vw'
  );
</script>

{#if block.entries.length}
  <section id={anchor} class="block overview overview-{block.layout} width-{block.width}">
    <ul class="overview-items">
      {#each block.entries as entry, i (entry.id)}
        <li class="overview-item">
          {#if block.layout === 'cards'}
            <article class="campaign-card-inner overview-card">
              {#if entry.image}
                <div class="campaign-card-image">
                  <Picture image={entry.image} base={model.base} {sizes} eager={eager && i === 0} />
                </div>
              {/if}
              <div class="campaign-card-text">
                <svelte:element this={headingTag(BLOCK_DEPTH)}>
                  <a href={withBase(model.base, entry.href)}>{entry.title}</a>
                </svelte:element>
                <p class="overview-date">
                  <time datetime={entry.date.iso}>{entry.date.label}</time>
                </p>
                {#if entry.summary}<p>{entry.summary}</p>{/if}
              </div>
            </article>
          {:else}
            <a href={withBase(model.base, entry.href)}>{entry.title}</a>
            <time class="overview-date" datetime={entry.date.iso}>{entry.date.label}</time>
          {/if}
        </li>
      {/each}
    </ul>
    {#if block.older || block.newer}
      <nav class="overview-pages" aria-label={copy.label}>
        {#if block.newer}<a href={withBase(model.base, block.newer)}>{copy.newer}</a>{/if}
        {#if block.older}<a href={withBase(model.base, block.older)}>{copy.older}</a>{/if}
      </nav>
    {/if}
  </section>
{/if}
