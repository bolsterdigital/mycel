<!-- A checkbox or radio group as a fieldset: the legend asks the question, each option is a
     native input with its own label, and the hint and error describe the whole group. The hint
     waits behind an ⓘ in the legend (HintButton, #87); the group is named by the legend's text
     alone (aria-labelledby), so the button's own name never becomes part of the question. `size`
     caps the group's width like a Field's (#102); inside a Fieldset it draws no border of its own,
     so a question within a group is one outline deep.
     `searchable` is for a list that can grow past a screen (#133): above eight options the chosen
     ones come first and the rest scrolls inside a box of a fixed height, which is the whole path
     without JavaScript; the script adds a search and a line naming what is chosen, so a choice made
     deep in the list stays in view. Only the form changes: what is posted is still the checkboxes,
     and the order of the list says nothing about the order saved. Rejected: moving a box to the top
     the moment it is ticked (the row leaves under the pointer and takes focus with it), and a
     listbox widget (it needs a script to choose at all). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ui } from '../../../../i18n/index.js';
  import HintButton from '../feedback/HintButton.svelte';
  import AdminScript from '../../trusted/AdminScript.svelte';
  import Field, { type FieldSize } from './Field.svelte';

  type Option = { value: string; label: string };

  /** Up to this many options a list fits by itself, and a search would only be in the way. */
  const SEARCH_FROM = 8;

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
    searchable = false,
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
    /** A list that can grow past a screen: chosen first, a bounded box and a search. */
    searchable?: boolean;
  } = $props();

  const t = $derived(ui(locale));
  const describedby = $derived(
    [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
  );
  const long = $derived(searchable && options.length > SEARCH_FROM);
  const rows = $derived(
    long
      ? [
          ...options.filter((o) => selected.includes(o.value)),
          ...options.filter((o) => !selected.includes(o.value)),
        ]
      : options
  );
</script>

{#snippet row(option: Option)}
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
{/snippet}

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
  {#if long}
    <div class="ui-choice-picker" data-choice-picker>
      <div class="ui-choice-tools" data-choice-tools hidden>
        <p class="ui-choice-chosen" data-choice-chosen hidden>
          {t('admin.ui.choices.chosen')} <span data-choice-names></span>
        </p>
        <Field
          id="{id}-search"
          label={t('admin.ui.choices.search')}
          {locale}
          type="search"
          autocomplete="off"
          data-choice-search
        />
        <p
          class="ui-hint"
          role="status"
          data-choice-count
          data-template={t('admin.ui.choices.count')}
        ></p>
      </div>
      <div class="ui-choice-list" data-choice-list>
        {#each rows as option (option.value)}{@render row(option)}{/each}
      </div>
      <AdminScript src="/_admin/choices.js" />
    </div>
  {:else}
    {#each rows as option (option.value)}{@render row(option)}{/each}
  {/if}
</fieldset>
