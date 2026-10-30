<!-- The edit pattern (brief #56 § B, § C2): the item's fields in the main column and its state
     and publishing in a side column beside them, as in WordPress's publish box and Payload's
     sidebar. The side column comes after the main one in the source and below it on a narrow
     page; the columns follow the width the page has (a container query), like DetailPage.
     Rejected: DetailPage with the form as its "preview", which names the main column wrongly and
     shrinks forms to their content. An item's edit screen puts its ItemBar where the header is
     (#66 PR 2). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLFormAttributes } from 'svelte/elements';
  import PageHeader from './PageHeader.svelte';

  type Crumb = { label: string; href?: string | undefined };

  let {
    title,
    locale,
    breadcrumb,
    description,
    actions,
    notices,
    aside,
    asideLabel,
    bar,
    form,
    children,
  }: {
    title: string;
    locale: string;
    breadcrumb?: readonly Crumb[] | undefined;
    description?: string | undefined;
    actions?: Snippet;
    notices?: Snippet;
    /** State and publishing of the item. */
    aside: Snippet;
    /** The side column's accessible name. */
    asideLabel: string;
    /** An item's own bar (ItemBar) in place of the page header; it carries the <h1>. */
    bar?: Snippet;
    /** Makes both columns one form, so the side column's fields are saved with the main ones. */
    form?: HTMLFormAttributes | undefined;
    /** The fields, in groups, and anything edited with them. */
    children: Snippet;
  } = $props();
</script>

<main class="page admin ui-edit-page">
  {#if bar}{@render bar()}{:else}<PageHeader
      {title}
      {locale}
      {breadcrumb}
      {description}
      {actions}
    />{/if}
  {#if notices}{@render notices()}{/if}
  <div class="ui-edit-host">
    {#snippet columns()}
      <div class="ui-edit-main">{@render children()}</div>
      <aside class="ui-edit-side" aria-label={asideLabel}>{@render aside()}</aside>
    {/snippet}
    {#if form}
      <form {...form} class="ui-edit">{@render columns()}</form>
    {:else}
      <div class="ui-edit">{@render columns()}</div>
    {/if}
  </div>
</main>
