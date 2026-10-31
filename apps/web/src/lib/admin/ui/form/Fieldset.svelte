<!-- A group of fields under one legend, for what a visitor sees as one part of the page (skill
     cms-inrichting rule 2). `collapsed` folds it into a native <details> for settings that rarely
     change (rule 4); the legend stays the group's accessible name either way.
     One outline deep (#102): two outlines inside each other read as "too many lines". A Fieldset
     inside a Fieldset renders as a flat subgroup, its legend as a subheading and no outline of
     its own (class `nested`); a Choices inside a group draws none either. A screen that wants
     real parts uses a table or a second section. The UI gate counts an outlined group inside a
     group on every admin route. Rejected: refusing to render a nested Fieldset, which would take
     down every block form that nests (BlockFields), and a lighter outline per depth, which keeps
     the nesting it hides. -->
<script lang="ts" module>
  /** The context key a Fieldset sets for what renders inside it. */
  export const GROUP = 'ui-group';
</script>

<script lang="ts">
  import { getContext, setContext, type Snippet } from 'svelte';

  let {
    legend,
    hint,
    collapsed,
    children,
  }: {
    legend: string;
    hint?: string | undefined;
    /** Undefined: always open. false/true: foldable, starting open or closed. */
    collapsed?: boolean | undefined;
    children: Snippet;
  } = $props();

  const nested = getContext(GROUP) === true;
  setContext(GROUP, true);
</script>

{#snippet group()}
  <fieldset class={['ui-fieldset', 'ui-group', nested && 'nested']}>
    <legend>{legend}</legend>
    {#if hint}<p class="ui-hint">{hint}</p>{/if}
    <div class="ui-fields">{@render children()}</div>
  </fieldset>
{/snippet}

{#if collapsed === undefined}
  {@render group()}
{:else}
  <details class="ui-fold" open={!collapsed}>
    <summary>{legend}</summary>
    {@render group()}
  </details>
{/if}
