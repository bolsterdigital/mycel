<!-- One block of an item on its edit screen (#66 PR 3, MY-110 A, #159): a card whose tinted head
     names the block (its place, its type as a label, the first words of its content, at most one
     notice) and holds "More actions" and, with JavaScript, "Collapse". Under the head the block at
     rest the way the page shows it (its picture with caption and credit, its text), and a fold
     whose summary is the named button "Edit" ("Done" while open) over the block's fields. Rest and
     edit are presentation state of the one document form: closing the fold keeps every typed
     value, and "Done" closes it without saving anything; the item bar saves. The fold is the
     `#block-<id>` target a save, an issue link and the live preview open and scroll to.

     Both disclosures are native `details`, so every field and action works without JavaScript; the
     screen's script adds Escape, a second "Done" under long fields, a click on the rest view, and
     collapsing. Collapse is a real button revealed by that script, not a `summary`: the head has to
     stay visible and holds controls of its own, and without JavaScript a block stays open. The
     number is the block's place in the tree and no identity (ADR 020): it moves with the block.
     Rejected: the preview inside the summary (its whole text became the button's name, and a block
     had no visible "Edit"), actions on hover (unreachable on touch and by keyboard), controls with
     only an icon (Jaap 2026-11-03: a visible word, always) and a modal or global properties panel
     (loses the reading context). A block with no fields at all (a paywall) has no fold: an "Edit"
     that opens nothing is a false promise; the card itself is then the `#block-<id>` target. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from '../Icon.svelte';
  import type { IconName } from '../icons.js';

  let {
    id,
    number,
    type,
    icon,
    name = '',
    nameIfEmpty = '',
    nameLang,
    notice = '',
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
    /** The block's 1-based place in the tree, shown as `05`. */
    number: number;
    /** The name of the block's type, in the operator's language. */
    type: string;
    icon: IconName;
    /** The first words of the block's content, so a collapsed block stays recognisable. */
    name?: string;
    /** What the name falls back to once the script finds its words emptied (a file name). */
    nameIfEmpty?: string;
    /** The language of those words: the content's, not necessarily the operator's. */
    nameLang?: string;
    /** At most one thing that asks attention, which stays in view when collapsed. */
    notice?: string;
    open?: boolean;
    /** False for a type without fields: no fold, only the rest view and the actions. */
    editable?: boolean;
    /** The words of the card's own controls, in the operator's language. */
    labels: {
      block: string;
      edit: string;
      done: string;
      more: string;
      collapse: string;
      expand: string;
    };
    /** A hook for the screen's tests and scripts, never for styling. */
    class?: string;
    /** The block's secondary actions, whole buttons listed under "More actions". */
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
  data-block-card={id}
>
  <div class="ui-block-card-head">
    <h4 class="ui-block-card-title" id="{id}-title">
      <span class="ui-block-card-number"
        ><span class="ui-visually-hidden">{`${labels.block} `}</span>{number
          .toString()
          .padStart(2, '0')}</span
      >
      <span class="ui-block-card-type"><Icon name={icon} /><span>{type}</span></span>
    </h4>
    <span class="ui-block-card-name" lang={nameLang} data-block-name={nameIfEmpty}>{name}</span>
    {#if notice}
      <span class="ui-block-card-notice"><Icon name="triangle-alert" /><span>{notice}</span></span>
    {/if}
    <div class="ui-block-card-controls">
      {#if actions}
        <details class="ui-block-card-more">
          <summary aria-describedby="{id}-title"
            ><Icon name="ellipsis" /><span>{labels.more}</span></summary
          >
          <div class="ui-block-card-menu">{@render actions()}</div>
        </details>
      {/if}
      <button
        type="button"
        class="ui-block-card-toggle"
        aria-expanded="true"
        aria-controls="{id}-content"
        aria-describedby="{id}-title"
        data-block-toggle
        hidden
      >
        <span class="ui-block-card-collapse"><Icon name="chevron-up" />{labels.collapse}</span>
        <span class="ui-block-card-expand"><Icon name="chevron-down" />{labels.expand}</span>
      </button>
    </div>
  </div>
  <div class="ui-block-card-content" id="{id}-content" data-block-content>
    <div class="ui-block-card-rest" data-block-rest>{@render rest()}</div>
    {#if editable}
      <details class={['ui-block-card-fold', extra]} {id} {open}>
        <summary aria-describedby="{id}-title"
          ><span class="ui-block-card-closed"><Icon name="pencil" />{labels.edit}</span><span
            class="ui-block-card-open"><Icon name="check" />{labels.done}</span
          ></summary
        >
        <div class="ui-block-card-body">
          {@render children()}
          <div class="ui-block-card-done" data-block-done hidden>
            <button type="button" class="ui-button secondary" aria-describedby="{id}-title"
              ><Icon name="check" />{labels.done}</button
            >
          </div>
        </div>
      </details>
    {/if}
  </div>
</section>
