<!-- A data table with a caption, sortable through links: the server sorts, so sorting works
     without JavaScript and the order is in the URL. The sorted column carries aria-sort; the
     arrow is decoration. On a narrow screen the table scrolls inside its own focusable region,
     never the page (WCAG 1.4.10 allows two-dimensional tables to scroll). `hideCaption` keeps the
     caption for screen readers only, for a table whose caption repeats the visible heading above
     it (#87). -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Dir = 'asc' | 'desc';

  let {
    id,
    caption,
    hideCaption = false,
    columns,
    sort,
    sortHref,
    rows,
  }: {
    id: string;
    caption: string;
    /** The caption repeats the heading above the table: visually hidden, still the table's name. */
    hideCaption?: boolean;
    columns: readonly { key: string; label: string; sortable?: boolean; numeric?: boolean }[];
    sort?: { key: string; dir: Dir } | undefined;
    /** The link that sorts by `key` in `dir`; required when a column is sortable. */
    sortHref?: ((key: string, dir: Dir) => string) | undefined;
    /** The <tr> elements of the body. */
    rows: Snippet;
  } = $props();

  const ariaSort = (key: string) =>
    sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined;
  const next = (key: string): Dir => (sort?.key === key && sort.dir === 'asc' ? 'desc' : 'asc');
</script>

<!-- A region that can scroll must be reachable by keyboard (axe scrollable-region-focusable). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="ui-table-scroll" role="region" aria-labelledby="{id}-caption" tabindex="0">
  <table class="ui-table" {id}>
    <caption id="{id}-caption" class={[hideCaption && 'ui-visually-hidden']}>{caption}</caption>
    <thead>
      <tr>
        {#each columns as column (column.key)}
          <th scope="col" aria-sort={ariaSort(column.key)} class={[column.numeric && 'numeric']}>
            {#if column.sortable && sortHref}
              <a href={sortHref(column.key, next(column.key))}
                >{column.label}<span class="ui-sort" aria-hidden="true"
                  >{sort?.key === column.key ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</span
                ></a
              >
            {:else}
              {column.label}
            {/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>{@render rows()}</tbody>
  </table>
</div>
