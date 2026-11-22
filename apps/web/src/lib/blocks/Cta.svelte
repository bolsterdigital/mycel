<script lang="ts">
  import { headingTag } from './headings.js';
  import type { RenderBlock, RenderModel } from './model.js';
  import Actions from './Actions.svelte';

  let {
    block,
    model,
    anchor,
    depth,
  }: {
    block: Extract<RenderBlock, { type: 'cta' }>;
    model: RenderModel;
    anchor?: string;
    depth: number;
  } = $props();
</script>

<section id={anchor} class="block cta cta-{block.variant} width-{block.width} align-{block.align}">
  <svelte:element this={headingTag(depth + 1)}>{block.title}</svelte:element>
  {#if block.body}<p>{block.body}</p>{/if}
  <Actions actions={block.actions} base={model.base} />
</section>
