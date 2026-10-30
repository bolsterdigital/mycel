<!-- Facts about one thing as a definition list: term beside value when the list is wide enough,
     term above value otherwise, so a long filename never squeezes a column (WCAG 1.4.10). A fact
     with several targets (the pages that use an image) lists them as links under its value. -->
<script lang="ts">
  type Link = { label: string; href: string };

  let {
    items,
  }: {
    items: readonly {
      term: string;
      value: string;
      href?: string | undefined;
      links?: readonly Link[] | undefined;
    }[];
  } = $props();
</script>

<div class="ui-meta-host">
  <dl class="ui-meta">
    {#each items as item, i (i)}
      <div>
        <dt>{item.term}</dt>
        <dd>
          {#if item.href}<a href={item.href}>{item.value}</a
            >{:else}{item.value}{/if}{#if item.links?.length}<ul class="ui-meta-links">
              {#each item.links as link (link.href)}<li>
                  <a href={link.href}>{link.label}</a>
                </li>{/each}
            </ul>{/if}
        </dd>
      </div>
    {/each}
  </dl>
</div>
