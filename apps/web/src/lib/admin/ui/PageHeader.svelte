<!-- The top of every admin screen: where you are, the one <h1>, a line on what the screen is for
     and the primary action in a fixed place (brief #56: the same spot on every screen). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Breadcrumb from './Breadcrumb.svelte';

  let {
    title,
    locale,
    breadcrumb,
    description,
    actions,
  }: {
    title: string;
    locale: string;
    breadcrumb?: readonly { label: string; href?: string | undefined }[] | undefined;
    description?: string | undefined;
    actions?: Snippet;
  } = $props();
</script>

<header class="ui-page-header">
  {#if breadcrumb?.length}<Breadcrumb {locale} items={breadcrumb} />{/if}
  <div class="ui-page-title">
    <div>
      <h1>{title}</h1>
      {#if description}<p class="ui-lead">{description}</p>{/if}
    </div>
    {#if actions}<div class="ui-page-actions">{@render actions()}</div>{/if}
  </div>
</header>
