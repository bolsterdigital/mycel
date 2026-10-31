<!-- The compact table of contents of a long document (#66 PR 6d, brief edit-screen § Aanvulling
     UX-review): one line per block, its number and kind and the start of what it says, each a link
     to its card. A `details`, closed by default, so it costs one line until it is wanted; the links
     are fragments, so it works without JavaScript and lands below the bar that stays in view
     (`scroll-padding`). Reordering stays with the cards (#80). Rejected: a sticky side panel like
     a list view, which the open preview takes the place of, and an outline of headings only,
     which leaves a page without headings (most campaign pages) without a way through. -->
<script lang="ts">
  import Icon from '../Icon.svelte';

  let {
    label,
    count,
    entries,
    open = false,
  }: {
    /** The fold's name, also the landmark's. */
    label: string;
    /** How many entries, in words ("24 blocks"). */
    count: string;
    /** In document order; the list numbers them as the cards are numbered. */
    entries: readonly { href: string; kind: string; text: string }[];
    /** Open from the start (the catalogue, so the UI gate measures the lines). */
    open?: boolean;
  } = $props();
</script>

<nav class="ui-outline" aria-label={label}>
  <details {open}>
    <summary
      ><Icon name="chevron-down" />{label} <span class="ui-outline-count">{count}</span></summary
    >
    <ol>
      {#each entries as entry (entry.href)}
        <li>
          <a href={entry.href}
            ><span class="ui-outline-kind">{entry.kind}</span>
            {#if entry.text}<span class="ui-outline-text">{entry.text}</span>{/if}</a
          >
        </li>
      {/each}
    </ol>
  </details>
</nav>
