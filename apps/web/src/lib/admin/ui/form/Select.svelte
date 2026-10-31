<!-- A native select inside a Field: label, hint, error and size the same as every other control. -->
<script lang="ts">
  import Field, { type FieldSize } from './Field.svelte';

  let {
    id,
    name,
    label,
    locale,
    options,
    value,
    hint,
    error,
    invalid = false,
    required = false,
    size,
  }: {
    id: string;
    name: string;
    label: string;
    locale: string;
    options: readonly { value: string; label: string }[];
    value?: string | undefined;
    hint?: string | undefined;
    error?: string | undefined;
    /** Marks the control invalid when its message stands elsewhere (an error summary). */
    invalid?: boolean;
    required?: boolean;
    /** How wide the select is (Field); a time zone or a font name is `m`. */
    size?: FieldSize | undefined;
  } = $props();
</script>

<Field {id} {label} {locale} {hint} {error} {invalid} {required} {size}>
  {#snippet control(attributes)}
    <select {name} {...attributes}>
      {#each options as option (option.value)}
        <option value={option.value} selected={option.value === value}>{option.label}</option>
      {/each}
    </select>
  {/snippet}
</Field>
