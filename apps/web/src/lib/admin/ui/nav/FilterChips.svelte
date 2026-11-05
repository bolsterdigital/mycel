<!-- The filters that are on, under a filter bar: each one says what it is and is a link that takes
     only that one off, so it works without JavaScript and the rest of the view stays. A link and
     not a button because removing a filter is going to another view of the list. The cross is
     decoration: the link's name says what it does. -->
<script lang="ts">
  import Icon from '../Icon.svelte';

  let {
    label,
    items,
  }: {
    /** Names the list for a screen reader. */
    label: string;
    items: readonly {
      /** What is on: "Status: Draft". */
      label: string;
      href: string;
      /** The link's full name: "Remove filter Status: Draft". */
      remove: string;
    }[];
  } = $props();
</script>

<ul class="ui-filter-chips" aria-label={label}>
  {#each items as item (item.href)}
    <li>
      <a href={item.href} aria-label={item.remove}>{item.label}<Icon name="x" /></a>
    </li>
  {/each}
</ul>
