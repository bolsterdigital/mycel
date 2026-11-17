<!-- An article's corrections after its body (ADR 012 rule 1): a section with its own heading, so a
     reader who jumps by headings finds it, and each dated note as a list item. A teaser has none:
     the core leaves them out, since they quote the body. Rejected: a line in the header above the
     title, which pushes the article down for every reader and reads as an alarm. -->
<script lang="ts">
  import { BLOCK_DEPTH, headingTag } from '#lib/blocks/headings.js';
  import type { RenderCorrections } from '#lib/blocks/model.js';

  let { corrections }: { corrections: RenderCorrections } = $props();
</script>

<section class="block page-corrections" aria-labelledby="page-corrections">
  <svelte:element this={headingTag(BLOCK_DEPTH)} id="page-corrections"
    >{corrections.title}</svelte:element
  >
  <ul>
    {#each corrections.entries as entry, i (i)}
      <li><time datetime={entry.date.iso}>{entry.date.label}</time>: {entry.text}</li>
    {/each}
  </ul>
</section>
