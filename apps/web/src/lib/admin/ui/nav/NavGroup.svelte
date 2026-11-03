<!-- One group of the admin's main navigation: an optional short label and a list of links, each
     with its icon. The label names the list (aria-labelledby) instead of being a heading, so the
     sidebar adds no headings before the page's own h1. The current item carries
     aria-current="page"; a group without items renders nothing, so a member who may see none of
     its screens sees no empty label. An item may bring its screen's sections as `children` (#87):
     a native disclosure with an explicit overview link. The active group starts open, but can
     close again without navigating. Rejected: a parent link that pretends to toggle children. -->
<script lang="ts">
  import Icon from '../Icon.svelte';
  import type { IconName } from '../icons.js';

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
          {#if item.children?.length}
            <details class="ui-navgroup-disclosure" open={item.current}>
              <summary data-nav-expand aria-current={item.current ? 'true' : undefined}
                ><Icon name={item.icon} /><span>{item.label}</span><Icon
                  name="chevron-down"
                /></summary
              >
              <ul class="ui-navgroup-sub">
                <li><a href={item.href} aria-current={mark(item)}>{item.label}</a></li>
                {#each item.children as child (child.href)}
                  <li>
                    <a href={child.href} aria-current={child.current ? 'page' : undefined}
                      >{child.label}</a
                    >
                  </li>
                {/each}
              </ul>
            </details>
          {:else}
            <a href={item.href} aria-current={mark(item)}
              ><Icon name={item.icon} /><span>{item.label}</span></a
            >
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}
