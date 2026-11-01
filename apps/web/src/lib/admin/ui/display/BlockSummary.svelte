<!-- A block at rest in words (#66 PR 3): its thumbnail beside its caption or first text, and the
     entries of a list one per line. Since MY-110 C every type has its own rest view
     (`lib/admin/block-presentation.ts`); this remains what a block without words says, "Still
     empty", until something is typed. -->
<script lang="ts">
  let {
    text,
    thumb = null,
    entries = [],
    empty,
  }: {
    /** The caption or first text in the item's language. */
    text: string;
    /** The image's thumbnail URL, when the block has one. */
    thumb?: string | null;
    /** One line per entry of a list (an FAQ's questions). */
    entries?: readonly string[];
    /** What the summary says when the block has no text yet. */
    empty: string;
  } = $props();
</script>

<div class="ui-block-summary">
  {#if thumb}<img src={thumb} alt="" width="96" height="72" loading="lazy" />{/if}
  <span class="ui-block-card-says">
    {#if text}<span class="ui-block-card-text">{text}</span>{/if}
    {#each entries as entry, i (i)}<span class="ui-block-card-entry">{entry}</span>{/each}
    {#if !text && !entries.length && !thumb}<span class="ui-block-card-empty">{empty}</span>{/if}
  </span>
</div>
