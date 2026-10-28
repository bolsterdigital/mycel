<!-- Previous and next as links, with an optional position ("Page 2 of 5"); works for numbered
     pages and for the cursor lists of the API alike. An absent direction is left out, not shown
     disabled: a disabled link does not exist in HTML. -->
<script lang="ts">
  import { ui } from '../../../i18n/index.js';

  let {
    locale,
    previous,
    next,
    position,
    label,
  }: {
    locale: string;
    previous?: string | undefined;
    next?: string | undefined;
    position?: string | undefined;
    /** Overrides "Pagination" when a page has more than one. */
    label?: string | undefined;
  } = $props();

  const t = $derived(ui(locale));
</script>

{#if previous || next}
  <nav class="ui-pagination" aria-label={label ?? t('admin.ui.pagination')}>
    {#if previous}<a class="ui-button secondary" href={previous} rel="prev"
        ><span aria-hidden="true">←</span> {t('admin.ui.previous')}</a
      >{/if}
    {#if position}<p>{position}</p>{/if}
    {#if next}<a class="ui-button secondary" href={next} rel="next"
        >{t('admin.ui.next')} <span aria-hidden="true">→</span></a
      >{/if}
  </nav>
{/if}
