<script lang="ts">
  import { fill, ui } from '../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.adminLocale));
  const lead = $derived(data.task === 'lead');
  const headline = $derived(data.task === 'headline');
  const proposed = $derived(form && 'value' in form ? form.value : data.value);
  /** A refused request keeps what was ticked; a retry starts from the suggestion's own blocks. */
  const chosen = $derived(
    form && 'blockIds' in form && form.blockIds ? form.blockIds : data.chosen
  );
  const passages = $derived(data.candidates.filter((c) => data.chosen.includes(c.blockId)));
  const heading = $derived(
    lead
      ? t('admin.assist.lead')
      : headline
        ? t('admin.assist.headline')
        : data.task === 'alt'
          ? t('admin.assist.alt')
          : t('admin.assist.translate')
  );
</script>

<svelte:head>
  <title>{t('admin.assist.title')}</title>
  {#if data.suggestion?.status === 'pending'}<meta http-equiv="refresh" content="3" />{/if}
</svelte:head>
<main class="page admin">
  <p><a href="/admin/{data.tenant.slug}/content/{data.itemId}">{t('admin.assist.back')}</a></p>
  <h1>{heading}</h1>
  {#if headline}
    <div class="passages">
      <p>{t('admin.assist.headline.source')} ({data.locale})</p>
      <blockquote>{data.source}</blockquote>
      <p>
        {fill(t('admin.assist.headline.sent'), { locale: data.locale, provider: data.provider })}
      </p>
    </div>
  {:else if !lead}
    <p>{t('admin.assist.source')} ({data.task === 'alt' ? data.locale : data.from})</p>
    <blockquote>{data.source}</blockquote>
  {/if}
  {#if form?.problem}<p role="alert">{t(`admin.assist.error.${form.problem}` as const)}</p>{/if}
  {#if data.stale || form?.problem === 'conflict'}
    <p role="alert">{t('admin.assist.stale')}</p>
  {/if}
  {#if data.suggestion?.status === 'pending' && !data.stale}
    <p role="status">{t('admin.assist.pending')}</p>
  {:else if data.suggestion?.status === 'ready' && !data.stale}
    {#if lead && passages.length}
      <section aria-labelledby="assist-based" class="passages">
        <h2 id="assist-based">{t('admin.assist.lead.based')} ({data.locale})</h2>
        {#each passages as passage (passage.blockId)}<blockquote>{passage.text}</blockquote>{/each}
      </section>
    {/if}
    <form method="post" action="?/accept{data.query}">
      <input type="hidden" name="suggestionId" value={data.suggestion.id} />
      <input type="hidden" name="baseRevisionId" value={data.revisionId} />
      {#each lead ? data.chosen : [] as id (id)}
        <input type="hidden" name="blockId" value={id} />
      {/each}
      <label for="assist-value">{t('admin.assist.proposal')}</label>
      {#if data.task === 'translate'}<p>{t('admin.assist.markdown')}</p>{/if}
      {#if lead || headline}
        <p id="assist-check">
          {t(headline ? 'admin.assist.headline.check' : 'admin.assist.lead.check')}
        </p>
      {/if}
      {#if headline}
        <!-- One line: a title has no line breaks, so the field cannot make one. -->
        <div class="ui-field">
          <input
            id="assist-value"
            name="value"
            maxlength="200"
            aria-describedby="assist-check"
            required
            value={proposed}
          />
        </div>
      {:else}
        <textarea
          id="assist-value"
          name="value"
          rows={lead ? 5 : 8}
          maxlength={data.task === 'alt' ? 250 : lead ? 1000 : undefined}
          aria-describedby={lead ? 'assist-check' : undefined}
          required>{proposed}</textarea
        >
      {/if}
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
      {#if lead}
        <fieldset aria-describedby="assist-lead-hint assist-lead-sent">
          <legend>{t('admin.assist.lead.choose')} ({data.locale})</legend>
          <p id="assist-lead-hint">{t('admin.assist.lead.hint')}</p>
          <p id="assist-lead-sent">
            {fill(t('admin.assist.lead.sent'), { locale: data.locale, provider: data.provider })}
          </p>
          {#each data.candidates as candidate, index (candidate.blockId)}
            <div class="passage">
              <input
                type="checkbox"
                id="lead-block-{candidate.blockId}"
                name="blockId"
                value={candidate.blockId}
                checked={chosen.includes(candidate.blockId)}
              />
              <label for="lead-block-{candidate.blockId}"
                >{fill(t('admin.assist.lead.block'), {
                  n: index + 1,
                  count: candidate.text.length,
                })}</label
              >
              <blockquote>{candidate.text}</blockquote>
            </div>
          {/each}
        </fieldset>
      {/if}
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
  fieldset {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }
  .passage {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.25rem 0.5rem;
    align-items: start;
  }
  .passage input {
    inline-size: 1.5rem;
    block-size: 1.5rem;
    margin: 0;
  }
  .passage blockquote {
    grid-column: 2;
  }
  blockquote {
    margin: 0;
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
  .passages {
    display: grid;
    gap: 0.5rem;
    margin-block-end: 1.5rem;
  }
  blockquote {
    padding-inline-start: 0.75rem;
    border-inline-start: 0.25rem solid var(--color-border-strong);
  }
</style>
