<!-- One checkbox that answers a yes/no question on its own (hide from search engines, use this
     group). Several options under one question are a Choices group instead. -->
<script lang="ts">
  let {
    id,
    name,
    label,
    checked = false,
    disabled = false,
    hint,
  }: {
    id: string;
    name: string;
    label: string;
    checked?: boolean;
    disabled?: boolean;
    hint?: string | undefined;
  } = $props();
</script>

<div class="ui-choice">
  <input
    type="checkbox"
    {id}
    {name}
    {checked}
    {disabled}
    aria-describedby={hint ? `${id}-hint` : undefined}
  />
  <label for={id}>{label}</label>
  {#if hint}<p class="ui-hint ui-choice-hint" id="{id}-hint">{hint}</p>{/if}
</div>
