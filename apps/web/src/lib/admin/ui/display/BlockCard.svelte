<!-- One block of an item on its edit screen (#66 PR 3, MY-110 A, brief block-editor-interactions
     § A): a card with a thin head (number and type, then "More actions" for move, duplicate and
     remove), the block at rest the way the page shows it (its picture with caption and credit,
     its text), and a fold whose summary is the named button "Edit" ("Done" while open) over the
     block's fields. Rest and edit are presentation state of the one document form: closing the
     fold keeps every typed value, and "Done" closes it without saving anything; the item bar
     saves. The fold is the `#block-<id>` target a save, an issue link and the live preview open
     and scroll to. Both disclosures are native `details`, so every field and action works without
     JavaScript; the screen's script adds Escape, a second "Done" under long fields and a click
     on the rest view. Rejected: the preview inside the summary (its whole text became the
     button's name, and a block had no visible "Edit"), actions on hover (unreachable on touch
     and by keyboard) and a modal or global properties panel (loses the reading context). A block
     with no fields at all (a paywall) has no fold: an "Edit" that opens nothing is a false promise;
     the card itself is then the `#block-<id>` target. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from '../Icon.svelte';

  let {
    id,
    title,
    open = false,
    editable = true,
    labels,
    class: extra = '',
    actions,
    rest,
    children,
  }: {
    /** The fold's id, `block-<id>`. */
    id: string;
    /** "3. Kop": the block's place and type. */
    title: string;
    open?: boolean;
    /** False for a type without fields: no fold, only the rest view and the actions. */
    editable?: boolean;
    /** The words of the card's own controls, in the operator's language. */
    labels: { edit: string; done: string; more: string };
    /** A hook for the screen's tests and scripts, never for styling. */
    class?: string;
    /** The block's secondary actions, whole buttons stacked under "More actions". */
    actions?: Snippet;
    /** The block at rest: what the page will show, without fields. */
    rest: Snippet;
    children: Snippet;
  } = $props();
</script>

<section
  class="ui-block-card"
  id={editable ? undefined : id}
  aria-labelledby="{id}-title"
  data-block-card
>
  <div class="ui-block-card-head">
    <h4 class="ui-block-card-title" id="{id}-title">{title}</h4>
    {#if actions}
      <details class="ui-block-card-more">
        <summary aria-describedby="{id}-title"
          ><span>{labels.more}</span><Icon name="chevron-down" /></summary
        >
        <div class="ui-block-card-menu">
          <div class="ui-actions stack">{@render actions()}</div>
        </div>
      </details>
    {/if}
  </div>
  <div class="ui-block-card-rest" data-block-rest>{@render rest()}</div>
  {#if editable}
    <details class={['ui-block-card-fold', extra]} {id} {open}>
      <summary aria-describedby="{id}-title"
        ><span class="ui-block-card-closed">{labels.edit}</span><span class="ui-block-card-open"
          >{labels.done}</span
        ></summary
      >
      <div class="ui-block-card-body">
        {@render children()}
        <div class="ui-block-card-done" data-block-done hidden>
          <button type="button" class="ui-button secondary" aria-describedby="{id}-title"
            >{labels.done}</button
          >
        </div>
      </div>
    </details>
  {/if}
</section>
