<!-- Cards in a list that fills the width with as many columns as fit (a thumbnail grid in the
     media library, sites on the overview); one column on a narrow screen. -->
<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';

  let {
    items,
    key,
    label,
    card,
  }: {
    items: readonly T[];
    key: (item: T) => string;
    /** The list's accessible name, when the heading above it does not give one. */
    label?: string | undefined;
    card: Snippet<[T]>;
  } = $props();
</script>

<ul class="ui-card-grid" aria-label={label}>
  {#each items as item (key(item))}
    <li>{@render card(item)}</li>
  {/each}
</ul>
