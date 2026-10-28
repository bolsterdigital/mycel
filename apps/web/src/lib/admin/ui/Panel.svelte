<!-- A foldable card for one part of a longer screen that has forms of its own, such as a block of
     a page: a native <details> whose summary names it, open when it is the part just worked on.
     A group of fields inside one form is a collapsed Fieldset instead. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    id,
    summary,
    open = false,
    class: extra = '',
    children,
  }: {
    id?: string | undefined;
    summary: string;
    open?: boolean;
    /** A hook for the screen's tests and scripts, never for styling. */
    class?: string;
    children: Snippet;
  } = $props();
</script>

<details class={['ui-panel', extra]} {id} {open}>
  <summary>{summary}</summary>
  <div class="ui-panel-body">{@render children()}</div>
</details>
