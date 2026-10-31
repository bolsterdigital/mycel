<!-- A colour as a small swatch with its hex code beside it (#102). The swatch is the native
     <input type="color">, so the system picker and its keyboard handling stay; the hex code is the
     field that posts, so the form works without JavaScript and a code can be pasted. With
     JavaScript the two follow each other, and `onchange` hears every valid colour. `hideLabel`
     keeps the label for screen readers only, for a cell whose row and column already name it
     (the theme's colour table). Rejected: a palette of our own, which would rebuild the system
     picker less accessibly; and the native input alone at full width, a wide coloured bar. -->
<script lang="ts">
  import { ui } from '../../../../i18n/index.js';
  import Field from './Field.svelte';

  const HEX = /^#[0-9a-f]{6}$/i;

  let {
    id,
    name,
    label,
    locale,
    value,
    hint,
    error,
    hideLabel = false,
    required = false,
    onchange,
  }: {
    id: string;
    name: string;
    label: string;
    locale: string;
    /** `#rrggbb`. */
    value: string;
    hint?: string | undefined;
    error?: string | undefined;
    hideLabel?: boolean;
    required?: boolean;
    /** Every valid colour picked or typed, for a live preview such as a contrast ratio. */
    onchange?: ((value: string) => void) | undefined;
  } = $props();

  const t = $derived(ui(locale));
  // svelte-ignore state_referenced_locally
  let current = $state(value);
  const pick = (next: string) => {
    if (!HEX.test(next)) return;
    current = next;
    onchange?.(next);
  };
</script>

<div class={['ui-color', hideLabel && 'hide-label']}>
  <Field {id} {label} {locale} {hint} {error} {required} size="s">
    {#snippet control(attributes)}
      <div class="ui-color-pair">
        <input
          type="color"
          id="{id}-swatch"
          class="ui-color-swatch"
          value={HEX.test(current) ? current.toLowerCase() : '#000000'}
          aria-label="{label}: {t('admin.ui.color.picker')}"
          oninput={(event) => pick(event.currentTarget.value)}
        />
        <input
          type="text"
          {name}
          {...attributes}
          value={current}
          pattern="#[0-9A-Fa-f]{'{6}'}"
          maxlength={7}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          oninput={(event) => pick(event.currentTarget.value)}
        />
      </div>
    {/snippet}
  </Field>
</div>
