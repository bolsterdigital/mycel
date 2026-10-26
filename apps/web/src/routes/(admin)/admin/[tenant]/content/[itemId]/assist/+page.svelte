<script lang="ts">
  import { ui, type UiKey } from '../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.adminLocale));
</script>

<svelte:head>
  <title>{t('admin.assist.title')}</title>
  {#if data.suggestion?.status === 'pending'}<meta http-equiv="refresh" content="3" />{/if}
</svelte:head>
<main class="page admin">
  <p><a href="/admin/{data.tenant.slug}/content/{data.itemId}">{t('admin.assist.back')}</a></p>
  <h1>{data.task === 'alt' ? t('admin.assist.alt') : t('admin.assist.translate')}</h1>
  <p>{t('admin.assist.source')} ({data.task === 'alt' ? data.locale : data.from})</p>
  <blockquote>{data.source}</blockquote>
  {#if form?.problem}<p role="alert">{t(`admin.assist.error.${form.problem}` as UiKey)}</p>{/if}
  {#if data.stale || form?.problem === 'conflict'}
    <p role="alert">{t('admin.assist.stale')}</p>
  {/if}
  {#if data.suggestion?.status === 'pending' && !data.stale}
    <p role="status">{t('admin.assist.pending')}</p>
  {:else if data.suggestion?.status === 'ready' && !data.stale}
    <form method="post" action="?/accept{data.query}">
      <input type="hidden" name="suggestionId" value={data.suggestion.id} />
      <input type="hidden" name="baseRevisionId" value={data.revisionId} />
      <label for="assist-value">{t('admin.assist.proposal')}</label>
      {#if data.task === 'translate'}<p>{t('admin.assist.markdown')}</p>{/if}
      <textarea
        id="assist-value"
        name="value"
        rows="8"
        maxlength={data.task === 'alt' ? 250 : undefined}
        required>{form?.value ?? data.value}</textarea
      >
      <div class="actions stack assist-actions">
        <button type="submit">{t('admin.assist.accept')}</button>
        <button type="submit" class="secondary" formaction="?/dismiss{data.query}" formnovalidate
          >{t('admin.assist.dismiss')}</button
        >
        <button type="submit" class="secondary" formaction="?/request{data.query}" formnovalidate
          >{t('admin.assist.retry')}</button
        >
      </div>
    </form>
  {:else if data.suggestion?.status === 'failed'}
    <p role="alert">{t('admin.assist.failed')}</p>
  {/if}
  {#if !data.suggestion || data.suggestion.status === 'failed' || data.stale || form?.problem === 'conflict'}
    <form method="post" action="?/request{data.query}">
      <input type="hidden" name="baseRevisionId" value={data.revisionId} />
      <button type="submit"
        >{data.suggestion ? t('admin.assist.retry') : t('admin.assist.request')}</button
      >
    </form>
  {/if}
</main>

<style>
  form {
    display: grid;
    gap: 0.75rem;
  }
  textarea {
    width: 100%;
    min-width: 0;
  }
  button {
    min-height: 2.75rem;
  }
</style>
