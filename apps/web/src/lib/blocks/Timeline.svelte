<!-- Dated events in one list, already sorted by the resolver. An ordered list, so a screen reader
     says how many there are and that the order means something; `time` carries the machine date.
     An event's title sits one level under the block's title, or at the block's level without one.
     Since MY-278 a rail with a dot per event: reached events filled, those still to come open and
     muted, and between the two a line "Now" on the site's clock at render (`when`, resolve.ts).
     The line is decoration (`aria-hidden`): every event's date already says which side it is on,
     so the list's count and reading stay the events alone. Rejected: a list item for "Now", which
     a screen reader would count and read as an event. -->
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
  // The first event on the other side of today, in the order shown; -1 when all are on one side.
  const turn = $derived(block.events.findIndex((e) => e.when !== block.events[0]?.when));
</script>

<section id={anchor} class="block timeline">
  {#if block.title}<svelte:element this={headingTag(depth + 1)}>{block.title}</svelte:element>{/if}
  <ol class="timeline-list">
    {#each block.events as event, i (i)}
      <li class:timeline-future={event.when === 'future'}>
        {#if i === turn}<span class="timeline-now" aria-hidden="true">{model.copy.timelineNow}</span
          >{/if}
        <time datetime={event.date}>{event.dateLabel}</time>
        <svelte:element this={eventHeading}>{event.title}</svelte:element>
        {#if event.body}<p>{event.body}</p>{/if}
        <Actions actions={event.actions} base={model.base} />
      </li>
    {/each}
  </ol>
</section>
