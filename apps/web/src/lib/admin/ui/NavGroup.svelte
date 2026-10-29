<!-- One group of the admin's main navigation: an optional short label and a list of links, each
     with its icon. The label names the list (aria-labelledby) instead of being a heading, so the
     sidebar adds no headings before the page's own h1. The current item carries
     aria-current="page"; a group without items renders nothing, so a member who may see none of
     its screens sees no empty label. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.js';

  let {
    id,
    label,
    items,
  }: {
    id: string;
    label?: string | undefined;
    items: readonly { href: string; label: string; icon: IconName; current?: boolean }[];
  } = $props();
</script>

{#if items.length}
  <div class="ui-navgroup">
    {#if label}<p class="ui-navgroup-label" id="{id}-label">{label}</p>{/if}
    <ul aria-labelledby={label ? `${id}-label` : undefined}>
      {#each items as item (item.href)}
        <li>
          <a href={item.href} aria-current={item.current ? 'page' : undefined}
            ><Icon name={item.icon} /><span>{item.label}</span></a
          >
        </li>
      {/each}
    </ul>
  </div>
{/if}
