<!-- The overview pattern (brief #56 § B): the page header with its primary action, notices,
     filters and the view switch above the list, the list itself or its empty state, and paging
     under it. A screen fills the snippets; the order and the spacing are the same everywhere.
     One visible heading per screen (#87, editor trial 4b-2: "Pages" four times): a list title
     equal to the page title stays for screen readers but is visually hidden, and the table that
     takes `listTitle` as its caption does the same; a different one (Media: "Files") shows. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import EmptyState from './EmptyState.svelte';
  import PageHeader from './PageHeader.svelte';
  import Pagination from './Pagination.svelte';
  import ViewSwitch from './ViewSwitch.svelte';

  type Crumb = { label: string; href?: string | undefined };
  type View = { href: string; label: string; current?: boolean };

  let {
    title,
    locale,
    breadcrumb,
    description,
    actions,
    notices,
    intro,
    filters,
    views,
    listTitle,
    empty,
    paging,
    children,
  }: {
    title: string;
    locale: string;
    breadcrumb?: readonly Crumb[] | undefined;
    description?: string | undefined;
    actions?: Snippet;
    notices?: Snippet;
    /** Content between the header and the list, such as an upload form. */
    intro?: Snippet;
    filters?: Snippet;
    views?: { label: string; items: readonly View[] } | undefined;
    /** The list's heading (h2); it also names the list region. */
    listTitle: string;
    /** Shown instead of the list when it has nothing. */
    empty?: { title: string; body?: string | undefined; action?: Snippet } | undefined;
    paging?: { previous?: string; next?: string; position?: string } | undefined;
    children?: Snippet;
  } = $props();
</script>

<main class="page admin ui-overview">
  <PageHeader {title} {locale} {breadcrumb} {description} {actions} />
  {#if notices}{@render notices()}{/if}
  {#if intro}{@render intro()}{/if}
  <section class="ui-overview-list" aria-labelledby="ui-overview-title">
    <div class="ui-overview-bar">
      <h2 id="ui-overview-title" class={[listTitle === title && 'ui-visually-hidden']}>
        {listTitle}
      </h2>
      {#if views}<ViewSwitch label={views.label} items={views.items} />{/if}
    </div>
    {#if filters}<div class="ui-overview-filters">{@render filters()}</div>{/if}
    {#if empty}
      <EmptyState title={empty.title} level={3} action={empty.action}>
        {#if empty.body}<p>{empty.body}</p>{/if}
      </EmptyState>
    {:else if children}
      {@render children()}
    {/if}
    {#if paging}<Pagination {locale} {...paging} />{/if}
  </section>
</main>
