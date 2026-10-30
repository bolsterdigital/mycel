<!-- One block of an item on its edit screen (#66 PR 3, brief edit-screen § 9a): a card with a thin
     head line (number and type, then the block's actions as whole buttons that wrap) and a fold
     whose summary shows what the block says the way the page will (its image, its caption or
     first text, the questions of an FAQ), so a folded list of blocks still reads as the page. The
     fields open under that summary. The fold is the `#block-<id>` target a save, an issue link
     and the live preview open and scroll to. Rejected: actions inside the summary (a button in a
     <summary> toggles the fold too, and screen readers read it as part of the toggle) and the
     former Panel with its actions under the fields (out of sight on a long block). -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    id,
    title,
    open = false,
    text,
    thumb = null,
    entries = [],
    empty,
    class: extra = '',
    actions,
    children,
  }: {
    /** The fold's id, `block-<id>`. */
    id: string;
    /** "3. Kop": the block's place and type. */
    title: string;
    open?: boolean;
    /** The caption or first text in the item's language. */
    text: string;
    /** The image's thumbnail URL, when the block has one. */
    thumb?: string | null;
    /** One line per entry of a list (an FAQ's questions). */
    entries?: readonly string[];
    /** What the summary says when the block has no text yet. */
    empty: string;
    /** A hook for the screen's tests and scripts, never for styling. */
    class?: string;
    actions?: Snippet;
    children: Snippet;
  } = $props();
</script>

<section class="ui-block-card" aria-labelledby="{id}-title">
  <div class="ui-block-card-head">
    <h4 class="ui-block-card-title" id="{id}-title">{title}</h4>
    {#if actions}
      <div class="ui-actions-host">
        <div class="ui-actions end">{@render actions()}</div>
      </div>
    {/if}
  </div>
  <details class={['ui-block-card-fold', extra]} {id} {open}>
    <summary>
      {#if thumb}<img src={thumb} alt="" width="96" height="72" loading="lazy" />{/if}
      <span class="ui-block-card-says">
        {#if text}<span class="ui-block-card-text">{text}</span>{/if}
        {#each entries as entry, i (i)}<span class="ui-block-card-entry">{entry}</span>{/each}
        {#if !text && !entries.length && !thumb}<span class="ui-block-card-empty">{empty}</span
          >{/if}
      </span>
    </summary>
    <div class="ui-block-card-body">{@render children()}</div>
  </details>
</section>
