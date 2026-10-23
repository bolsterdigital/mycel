<!-- A form block (`form` and the legacy `signup-form`): a native form that posts to the page's
     own action and works without JavaScript (ADR 009). Moved from the probe's page unchanged:
     labels tied to inputs, errors linked with aria-describedby, an error summary on top after a
     failed post, the honeypot out of sight (and out of reach of the password managers that fill
     a `website` field anyway: the four `data-*ignore` attributes), the signed `_started` token
     and the proof-of-work challenge for `static/_form/proof.js`, which adds nothing visible.
     `card` is a wrapper class. No ARIA where native semantics suffice. -->
<script lang="ts">
  import type { FormState, RenderForm, RenderModel } from './model.js';

  let {
    form: def,
    variant,
    width,
    model,
    state,
  }: {
    form: RenderForm;
    variant: 'default' | 'card';
    width: 'content' | 'wide' | 'full';
    model: RenderModel;
    state: FormState | null | undefined;
  } = $props();

  const mine = $derived(state?.formId === def.formId ? state : null);
  const hasProblem = $derived(!!mine && (mine.errors.length > 0 || !!mine.message));
  const errorFor = (field: string) => mine?.errors.find((e) => e.field === field)?.message;
</script>

<svelte:head>
  <!-- Solves the proof-of-work challenge in `data-proof` into `_proof`; one module per page,
       however many forms. Without it the form still posts, on the stricter route. -->
  <script type="module" src="/_form/proof.js"></script>
</svelte:head>

<div class="block form form-{variant} width-{width}">
  <form method="post" class="signup" data-proof={JSON.stringify(def.proof)}>
    {#if mine && hasProblem}
      <div class="error-summary" role="alert" aria-labelledby="summary-{def.formId}">
        <h2 id="summary-{def.formId}">{model.copy.summaryTitle}</h2>
        {#if mine.message}<p>{mine.message}</p>{/if}
        {#if mine.errors.length}
          <ul>
            {#each mine.errors as e (e.field)}
              <li><a href="#f-{def.formId}-{e.field}">{e.message}</a></li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    <input type="hidden" name="formId" value={def.formId} />
    <input type="hidden" name="locale" value={model.locale} />
    <input type="hidden" name="_started" value={def.startedToken} />
    <input type="hidden" name="_proof" value="" />
    <div class="hp" aria-hidden="true">
      <label for="f-{def.formId}-website">{model.copy.honeypotLabel}</label>
      <input
        id="f-{def.formId}-website"
        name="website"
        type="text"
        tabindex="-1"
        autocomplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        data-form-type="other"
      />
    </div>

    {#each def.fields as field (field.name)}
      {@const id = `f-${def.formId}-${field.name}`}
      {@const error = errorFor(field.name)}
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
            value={mine?.values?.['email'] ?? ''}
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

    <button type="submit">{def.submitLabel}</button>
  </form>
</div>
