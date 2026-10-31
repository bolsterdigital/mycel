<!-- A checkbox or radio group as a fieldset: the legend asks the question, each option is a
     native input with its own label, and the hint and error describe the whole group. The hint
     waits behind an ⓘ in the legend (HintButton, #87); the group is named by the legend's text
     alone (aria-labelledby), so the button's own name never becomes part of the question. `size`
     caps the group's width like a Field's (#102); inside a Fieldset it draws no border of its own,
     so a question within a group is one outline deep. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ui } from '../../../../i18n/index.js';
  import HintButton from '../feedback/HintButton.svelte';
  import type { FieldSize } from './Field.svelte';

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
    invalid = false,
    required = false,
    optionLabel,
    size = 'l',
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
    /** Marks the options invalid when the message stands elsewhere (an error summary). */
    invalid?: boolean;
    required?: boolean;
    /** Renders a label's content instead of its plain text, e.g. an identifier with break points. */
    optionLabel?: Snippet<[Option]>;
    /** How wide the group may grow (Field); `l` by default. */
    size?: FieldSize;
  } = $props();

  const t = $derived(ui(locale));
  const describedby = $derived(
    [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
  );
</script>

<fieldset
  class={['ui-fieldset', 'ui-choices', `size-${size}`, (error || invalid) && 'invalid']}
  aria-labelledby={hint ? `${id}-legend` : undefined}
  aria-describedby={describedby}
>
  <legend
    ><span id="{id}-legend"
      >{legend}{#if required}<span class="ui-required">{` (${t('admin.ui.required')})`}</span
        >{/if}</span
    >{#if hint}<HintButton target="{id}-hint" labelId="{id}-legend" {locale} />{/if}</legend
  >
  {#if hint}<p class="ui-hint" id="{id}-hint" popover>{hint}</p>{/if}
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
        aria-invalid={error || invalid ? 'true' : undefined}
      />
      <label for="{id}-{option.value}"
        >{#if optionLabel}{@render optionLabel(option)}{:else}{option.label}{/if}</label
      >
    </div>
  {/each}
</fieldset>
