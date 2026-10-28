<!-- Sub-navigation between the sections of one screen (settings per subject, tabs of an item).
     Links, not ARIA tabs: each section is its own URL and works without JavaScript; the current
     one carries aria-current="page". Items wrap; none is ever cut off. -->
<script lang="ts">
  let {
    label,
    items,
  }: {
    label: string;
    items: readonly { href: string; label: string; current?: boolean }[];
  } = $props();
</script>

<nav class="ui-subnav" aria-label={label}>
  <ul>
    {#each items as item (item.href)}
      <li>
        <a href={item.href} aria-current={item.current ? 'page' : undefined}>{item.label}</a>
      </li>
    {/each}
  </ul>
</nav>
