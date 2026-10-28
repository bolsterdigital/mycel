<!-- The detail pattern (brief #56 § B): a large preview beside the facts and the edit form, the
     preview on top when the space is narrow, and the item's actions in one group at the end.
     The columns follow the width the page actually has (a container query), not the viewport,
     so the sidebar of the admin shell does not squeeze them. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import PageHeader from './PageHeader.svelte';

  type Crumb = { label: string; href?: string | undefined };

  let {
    title,
    locale,
    breadcrumb,
    description,
    actions,
    notices,
    preview,
    previewLabel,
    meta,
    children,
    footer,
  }: {
    title: string;
    locale: string;
    breadcrumb?: readonly Crumb[] | undefined;
    description?: string | undefined;
    actions?: Snippet;
    notices?: Snippet;
    preview: Snippet;
    /** The preview region's accessible name. */
    previewLabel: string;
    /** The facts, usually a MetaList. */
    meta?: Snippet;
    /** The edit form, in groups. */
    children?: Snippet;
    /** The item's actions (download, delete), usually an Actions group. */
    footer?: Snippet;
  } = $props();
</script>

<main class="page admin ui-detail-page">
  <PageHeader {title} {locale} {breadcrumb} {description} {actions} />
  {#if notices}{@render notices()}{/if}
  <div class="ui-detail-host">
    <div class="ui-detail">
      <section class="ui-detail-preview" aria-label={previewLabel}>{@render preview()}</section>
      <div class="ui-detail-side">
        {#if meta}{@render meta()}{/if}
        {#if children}{@render children()}{/if}
      </div>
    </div>
  </div>
  {#if footer}<div class="ui-detail-footer">{@render footer()}</div>{/if}
</main>
