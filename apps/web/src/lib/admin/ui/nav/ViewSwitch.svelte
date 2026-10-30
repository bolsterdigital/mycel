<!-- A switch between two or more views of one list (grid or list): links that keep the view in
     the URL, so it works without JavaScript and survives a reload; the current view carries
     aria-current. Rejected: a radio group that needs a script to apply the choice. -->
<script lang="ts">
  let {
    label,
    items,
  }: {
    label: string;
    items: readonly { href: string; label: string; current?: boolean }[];
  } = $props();
</script>

<nav class="ui-view-switch" aria-label={label}>
  <ul>
    {#each items as item (item.href)}
      <li>
        <a href={item.href} aria-current={item.current ? 'page' : undefined}>{item.label}</a>
      </li>
    {/each}
  </ul>
</nav>
