<!-- Dated events in one list, already sorted by the resolver. An ordered list, so a screen reader
     says how many there are and that the order means something; `time` carries the machine date.
     An event's title sits one level under the block's title, or at the block's level without one. -->
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
    block: Extract<RenderBlock, { type: 'timeline' }>;
    model: RenderModel;
    anchor?: string;
    depth: number;
  } = $props();

  const eventHeading = $derived(headingTag(block.title ? depth + 2 : depth + 1));
</script>

<section id={anchor} class="block timeline">
  {#if block.title}<svelte:element this={headingTag(depth + 1)}>{block.title}</svelte:element>{/if}
  <ol class="timeline-list">
    {#each block.events as event, i (i)}
      <li>
        <time datetime={event.date}>{event.dateLabel}</time>
        <svelte:element this={eventHeading}>{event.title}</svelte:element>
        {#if event.body}<p>{event.body}</p>{/if}
        <Actions actions={event.actions} base={model.base} />
      </li>
    {/each}
  </ol>
</section>
