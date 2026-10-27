<!-- Questions are h3 under the block's h2, or h2 straight under the document's h1 when the block
     has no title, so the outline never skips a level. `accordion`
     is <details>/<summary>: usable without JavaScript, keyboard and screen reader included. -->
<script lang="ts">
  import { BLOCK_DEPTH, headingTag } from './headings.js';
  import type { RenderBlock, RenderModel } from './model.js';
  import RichText from './RichText.svelte';

  let { block, model }: { block: Extract<RenderBlock, { type: 'faq' }>; model: RenderModel } =
    $props();

  const depth = $derived(block.title ? BLOCK_DEPTH + 1 : BLOCK_DEPTH);
  const question = $derived(headingTag(depth));
</script>

<section class="block faq faq-{block.variant} width-{block.width}">
  {#if block.title}<svelte:element this={headingTag(BLOCK_DEPTH)}>{block.title}</svelte:element
    >{/if}
  {#each block.entries as entry, i (i)}
    {#if block.variant === 'accordion'}
      <details>
        <summary><svelte:element this={question}>{entry.question}</svelte:element></summary>
        <RichText doc={entry.answer} {model} {depth} idPrefix="{block.id}-{i}" class="answer" />
      </details>
    {:else}
      <svelte:element this={question}>{entry.question}</svelte:element>
      <RichText doc={entry.answer} {model} {depth} idPrefix="{block.id}-{i}" class="answer" />
    {/if}
  {/each}
</section>
