<!-- One group of the admin's main navigation: an optional short label and a list of links, each
     with its icon. The label names the list (aria-labelledby) instead of being a heading, so the
     sidebar adds no headings before the page's own h1. The current item carries
     aria-current="page"; a group without items renders nothing, so a member who may see none of
     its screens sees no empty label. An item may bring its screen's sections as `children` (#87):
     an indented list under it, the current section marked "page" and the item itself "true", so
     there is still one current page. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.js';

  type Child = { label: string; href: string; current?: boolean };

  let {
    id,
    label,
    items,
  }: {
    id: string;
    label?: string | undefined;
    items: readonly {
      href: string;
      label: string;
      icon: IconName;
      current?: boolean;
      children?: readonly Child[] | undefined;
    }[];
  } = $props();

  const mark = (item: (typeof items)[number]) =>
    !item.current ? undefined : item.children?.some((c) => c.current) ? 'true' : 'page';
</script>

{#if items.length}
  <div class="ui-navgroup">
    {#if label}<p class="ui-navgroup-label" id="{id}-label">{label}</p>{/if}
    <ul aria-labelledby={label ? `${id}-label` : undefined}>
      {#each items as item (item.href)}
        <li>
          <a href={item.href} aria-current={mark(item)}
            ><Icon name={item.icon} /><span>{item.label}</span></a
          >
          {#if item.children?.length}
            <ul class="ui-navgroup-sub">
              {#each item.children as child (child.href)}
                <li>
                  <a href={child.href} aria-current={child.current ? 'page' : undefined}
                    >{child.label}</a
                  >
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}
