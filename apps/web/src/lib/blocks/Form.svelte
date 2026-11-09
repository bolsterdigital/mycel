<!-- A form block (`form` and the legacy `signup-form`): a native form that posts to the page's
     own action and works without JavaScript (ADR 009). Moved from the probe's page unchanged:
     labels tied to inputs, errors linked with aria-describedby, an error summary on top after a
     failed post, the honeypot out of sight (and out of reach of the password managers that fill
     a `website` field anyway: the four `data-*ignore` attributes), the signed `_started` token
     and the proof-of-work challenge for `static/_form/proof.js`, which adds nothing visible.
     `card` is a wrapper class. No ARIA where native semantics suffice. In the admin preview (#11)
     `preview` is the note to show, the fields sit in a disabled fieldset and the proof script is
     not loaded: a preview never posts. -->
<script lang="ts">
  import type { FormState, RenderForm, RenderModel } from './model.js';

  let {
    form: def,
    variant,
    width,
    model,
    state,
    preview = null,
  }: {
    form: RenderForm;
    variant: 'default' | 'card';
    width: 'content' | 'wide' | 'full';
    model: RenderModel;
    state: FormState | null | undefined;
    preview?: string | null;
  } = $props();

  const mine = $derived(state?.formId === def.formId ? state : null);
  const hasProblem = $derived(!!mine && (mine.errors.length > 0 || !!mine.message));
  const textValue = (name: string) => {
    const value = mine?.values?.[name];
    return typeof value === 'string' ? value : '';
  };
  const errorFor = (field: string) => mine?.errors.find((e) => e.field === field)?.message;
</script>

<svelte:head>
  <!-- Solves the proof-of-work challenge in `data-proof` into `_proof`; one module per page,
       however many forms. Without it the form still posts, on the stricter route. -->
  {#if !preview}<script type="module" src="/_form/proof.js"></script>{/if}
</svelte:head>

<div class="block form form-{variant} width-{width}">
  <form method="post" class="signup" data-proof={JSON.stringify(def.proof)}>
    {#if preview}
      <p class="muted">{preview}</p>
      <fieldset disabled class="preview">{@render body()}</fieldset>
    {:else}
      {@render body()}
    {/if}
  </form>
</div>

{#snippet body()}
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

  {#if def.conditionalHelp}<p>{def.conditionalHelp}</p>{/if}
  {#if def.version}<input type="hidden" name="_formVersion" value={def.version} />{/if}
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
    {@const describedBy =
      [error ? `${id}-error` : '', field.help ? `${id}-help` : ''].filter(Boolean).join(' ') ||
      undefined}
    {#if field.type === 'hidden'}
      <input type="hidden" name={field.name} value={field.value ?? ''} />
    {:else if field.type === 'consent' || field.type === 'checkbox'}
      <div class="field check">
        {#if error}<p class="error" id="{id}-error">{error}</p>{/if}
        <input
          {id}
          name={field.name}
          type="checkbox"
          required={field.required}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy}
          checked={['on', 'true', '1'].includes(textValue(field.name))}
        />
        <label for={id}>{field.label}</label>
        {#if field.help}<p id="{id}-help">{field.help}</p>{/if}
      </div>
    {:else}
      <div class="field">
        <label for={id}>{field.label}</label>
        {#if field.help}<p id="{id}-help">{field.help}</p>{/if}
        {#if error}<p class="error" id="{id}-error">{error}</p>{/if}
        {#if field.type === 'textarea'}
          <textarea
            autocomplete="off"
            {id}
            name={field.name}
            required={field.required}
            maxlength={field.maxLength ?? 10000}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={describedBy}>{textValue(field.name)}</textarea
          >
        {:else if field.type === 'choice' || field.type === 'multiple-choice'}
          <select
            autocomplete="off"
            {id}
            name={field.name}
            multiple={field.type === 'multiple-choice'}
            required={field.required}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={describedBy}
          >
            {#if field.type === 'choice'}<option value=""></option>{/if}
            {#each field.options ?? [] as option (option.value)}
              <option
                value={option.value}
                selected={Array.isArray(mine?.values?.[field.name])
                  ? mine?.values?.[field.name]?.includes(option.value)
                  : textValue(field.name) === option.value}>{option.label}</option
              >
            {/each}
          </select>
        {:else}
          <input
            {id}
            name={field.name}
            type={field.type === 'email'
              ? 'email'
              : field.type === 'phone'
                ? 'tel'
                : field.type === 'date'
                  ? 'date'
                  : field.type === 'number' || field.type === 'amount'
                    ? 'number'
                    : 'text'}
            autocomplete={field.type === 'email'
              ? 'email'
              : field.type === 'phone'
                ? 'tel'
                : field.name === 'name'
                  ? 'name'
                  : 'off'}
            required={field.required}
            min={field.min}
            max={field.max}
            step={field.type === 'amount' ? '0.01' : field.type === 'number' ? 'any' : undefined}
            maxlength={field.maxLength}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={describedBy}
            value={textValue(field.name)}
          />
        {/if}
      </div>
    {/if}
  {/each}

  <button type="submit">{def.submitLabel}</button>
{/snippet}
