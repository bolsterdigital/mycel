<!-- A checkbox or radio group as a fieldset: the legend asks the question, each option is a
     native input with its own label, and the hint and error describe the whole group. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ui } from '../../../i18n/index.js';

  type Option = { value: string; label: string };

  let {
    id,
    name,
    legend,
    locale,
    type = 'radio',
    options,
    selected = [],
    hint,
    error,
    required = false,
    optionLabel,
  }: {
    id: string;
    name: string;
    legend: string;
    locale: string;
    type?: 'radio' | 'checkbox';
    options: readonly Option[];
    selected?: readonly string[];
    hint?: string | undefined;
    error?: string | undefined;
    required?: boolean;
    /** Renders a label's content instead of its plain text, e.g. an identifier with break points. */
    optionLabel?: Snippet<[Option]>;
  } = $props();

  const t = $derived(ui(locale));
  const describedby = $derived(
    [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
  );
</script>

<fieldset class={['ui-fieldset', 'ui-choices', error && 'invalid']} aria-describedby={describedby}>
  <legend
    >{legend}{#if required}<span class="ui-required">{` (${t('admin.ui.required')})`}</span
      >{/if}</legend
  >
  {#if hint}<p class="ui-hint" id="{id}-hint">{hint}</p>{/if}
  {#if error}<p class="ui-error" id="{id}-error">{error}</p>{/if}
  {#each options as option (option.value)}
    <div class="ui-choice">
      <input
        {type}
        id="{id}-{option.value}"
        {name}
        value={option.value}
        checked={selected.includes(option.value)}
        required={required && type === 'radio'}
      />
      <label for="{id}-{option.value}"
        >{#if optionLabel}{@render optionLabel(option)}{:else}{option.label}{/if}</label
      >
    </div>
  {/each}
</fieldset>
