<!-- A row of cards, each with a title, a text and one link styled as a button. A list, so a screen
     reader says how many there are; the number of columns follows the width on offer, not a prop. -->
<script lang="ts">
  import { BLOCK_DEPTH, headingTag } from './headings.js';
  import type { RenderBlock, RenderModel } from './model.js';
  import Actions from './Actions.svelte';

  let { block, model }: { block: Extract<RenderBlock, { type: 'cards' }>; model: RenderModel } =
    $props();
</script>

<section class="block cards cards-{block.accent} width-{block.width}">
  <ul class="cards-grid">
    {#each block.cards as card, i (i)}
      <li class="card">
        <svelte:element this={headingTag(BLOCK_DEPTH)}>{card.title}</svelte:element>
        {#if card.body}<p>{card.body}</p>{/if}
        <Actions actions={card.actions} base={model.base} />
      </li>
    {/each}
  </ul>
</section>
