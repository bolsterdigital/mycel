<!-- Block renderer for public pages (ADR 004 rule 2-3). The page title is the h1; top-level
     heading blocks are h2 (level from tree depth). The signup block is a native form: labels
     tied to inputs, errors linked with aria-describedby, an error summary on top after a failed
     post. No ARIA where native semantics suffice. -->
<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  const errorFor = (formId: string, field: string) =>
    form?.formId === formId ? form.errors.find((e) => e.field === field)?.message : undefined;
  const hasProblem = $derived(!!form && (form.errors.length > 0 || !!form.message));
</script>

<svelte:head>
  <title>{hasProblem ? `${data.copy.errorPrefix} ` : ''}{data.title}</title>
</svelte:head>

<main class="page">
  <h1>{data.title}</h1>

  {#each data.blocks as block, i (i)}
    {#if block.kind === 'heading'}
      <h2>{block.text}</h2>
    {:else}
      <form method="post" class="signup">
        {#if form?.formId === block.formId && hasProblem}
          <div class="error-summary" role="alert" aria-labelledby="summary-{block.formId}">
            <h2 id="summary-{block.formId}">{data.copy.summaryTitle}</h2>
            {#if form.message}<p>{form.message}</p>{/if}
            {#if form.errors.length}
              <ul>
                {#each form.errors as e (e.field)}
                  <li><a href="#f-{block.formId}-{e.field}">{e.message}</a></li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}

        <input type="hidden" name="formId" value={block.formId} />
        <input type="hidden" name="locale" value={data.locale} />
        <input type="hidden" name="_started" value={block.startedToken} />
        <div class="hp" aria-hidden="true">
          <label for="f-{block.formId}-website">{data.copy.honeypotLabel}</label>
          <input
            id="f-{block.formId}-website"
            name="website"
            type="text"
            tabindex="-1"
            autocomplete="off"
          />
        </div>

        {#each block.fields as field (field.name)}
          {@const id = `f-${block.formId}-${field.name}`}
          {@const error = errorFor(block.formId, field.name)}
          {#if field.type === 'email'}
            <div class="field">
              <label for={id}>{field.label}</label>
              {#if error}<p class="error" id="{id}-error">{error}</p>{/if}
              <input
                {id}
                name={field.name}
                type="email"
                autocomplete="email"
                required={field.required}
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
                value={form?.formId === block.formId ? (form.values?.email ?? '') : ''}
              />
            </div>
          {:else}
            <div class="field check">
              {#if error}<p class="error" id="{id}-error">{error}</p>{/if}
              <input
                {id}
                name={field.name}
                type="checkbox"
                required={field.required}
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
              />
              <label for={id}>{field.label}</label>
            </div>
          {/if}
        {/each}

        <button type="submit">{block.submitLabel}</button>
      </form>
    {/if}
  {/each}
</main>
