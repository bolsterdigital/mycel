<!-- Where this screen sits: an ordered list in a labelled nav; the last item is the current page,
     marked with aria-current and not a link. -->
<script lang="ts">
  import { ui } from '../../../i18n/index.js';

  let {
    locale,
    items,
  }: { locale: string; items: readonly { label: string; href?: string | undefined }[] } = $props();

  const t = $derived(ui(locale));
</script>

<nav class="ui-breadcrumb" aria-label={t('admin.ui.breadcrumb')}>
  <ol>
    {#each items as item, i (i)}
      <li>
        {#if item.href && i < items.length - 1}
          <a href={item.href}>{item.label}</a>
        {:else}
          <span aria-current="page">{item.label}</span>
        {/if}
      </li>
    {/each}
  </ol>
</nav>
