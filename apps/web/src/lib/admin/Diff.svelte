<!-- The changes between two revisions as a table (ADR 009 rule 9): the changed path, the value
     before and after. Used by the conflict notice and the revision comparison (TODO #11 A1). A
     narrow screen scrolls the table inside its own box, never the page (WCAG 1.4.10 allows it
     for data tables). -->
<script lang="ts">
  import { ui } from '../../i18n/index.js';

  let {
    rows,
    locale,
  }: { rows: { path: string; before: string; after: string }[]; locale: string } = $props();
  const t = $derived(ui(locale));
</script>

{#if rows.length === 0}
  <p>{t('admin.content.diff.none')}</p>
{:else}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex: a scrolling region must be reachable by keyboard (axe scrollable-region-focusable) -->
  <div class="table-scroll" role="region" aria-label={t('admin.content.diff.label')} tabindex="0">
    <table class="diff">
      <thead>
        <tr>
          <th scope="col">{t('admin.content.diff.path')}</th>
          <th scope="col">{t('admin.content.diff.before')}</th>
          <th scope="col">{t('admin.content.diff.after')}</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.path)}
          <tr>
            <th scope="row"><code>{row.path}</code></th>
            <td>{row.before}</td>
            <td>{row.after}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
