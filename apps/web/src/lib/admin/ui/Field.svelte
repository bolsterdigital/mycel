<!-- A labelled control with its hint and error, wired by id (WCAG 1.3.1, 3.3.1): the hint and the
     error are the control's description, an error sets aria-invalid. Without `control` it renders
     a text input; a select, textarea or custom control comes in as the `control` snippet and
     receives the attributes to spread. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { ui } from '../../../i18n/index.js';

  export type ControlAttributes = {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': 'true' | undefined;
    required: boolean;
  };

  let {
    id,
    label,
    locale,
    hint,
    error,
    required = false,
    invalid = false,
    control,
    ...input
  }: {
    id: string;
    label: string;
    locale: string;
    hint?: string | undefined;
    error?: string | undefined;
    required?: boolean;
    /** Marks the control invalid when its message stands elsewhere (an error summary). */
    invalid?: boolean;
    control?: Snippet<[ControlAttributes]>;
  } & Omit<HTMLInputAttributes, 'id' | 'required'> = $props();

  const t = $derived(ui(locale));
  const attributes = $derived<ControlAttributes>({
    id,
    'aria-describedby':
      [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined,
    'aria-invalid': error || invalid ? 'true' : undefined,
    required,
  });
</script>

<div class={['ui-field', (error || invalid) && 'invalid']}>
  <label for={id}
    >{label}{#if required}<span class="ui-required">{` (${t('admin.ui.required')})`}</span
      >{/if}</label
  >
  {#if hint}<p class="ui-hint" id="{id}-hint">{hint}</p>{/if}
  {#if error}<p class="ui-error" id="{id}-error">{error}</p>{/if}
  {#if control}
    {@render control(attributes)}
  {:else}
    <input type="text" {...input} {...attributes} />
  {/if}
</div>
