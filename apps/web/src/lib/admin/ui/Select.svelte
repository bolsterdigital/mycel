<!-- A native select inside a Field: label, hint and error the same as every other control. -->
<script lang="ts">
  import Field from './Field.svelte';

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
  } = $props();
</script>

<Field {id} {label} {locale} {hint} {error} {invalid} {required}>
  {#snippet control(attributes)}
    <select {name} {...attributes}>
      {#each options as option (option.value)}
        <option value={option.value} selected={option.value === value}>{option.label}</option>
      {/each}
    </select>
  {/snippet}
</Field>
