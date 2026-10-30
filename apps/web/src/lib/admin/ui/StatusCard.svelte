<!-- The state and publication of one locale of an item (brief edit-screen § 4, table stake 8):
     the state in words first, then what holds a publish back, then the main action and the rarer
     ones. Anything that must be read before a button (ADR 018 rule 6) goes in `children`, which
     comes before the actions. The actions stack once the card is narrow (skill
     ui-action-layout). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Actions from './Actions.svelte';
  import Badge from './Badge.svelte';

  let {
    id,
    title,
    state,
    tone = 'neutral',
    level = 2,
    children,
    actions,
    more,
  }: {
    id: string;
    title: string;
    /** The state in words. */
    state: string;
    tone?: 'neutral' | 'info' | 'success' | 'warning' | 'error';
    level?: 2 | 3;
    /** Notes and issues, read before any action. */
    children?: Snippet;
    /** The main action first, then the others. */
    actions?: Snippet;
    /** Folded, rarer choices under the actions (scheduling). */
    more?: Snippet;
  } = $props();
</script>

<section class="ui-status-card" {id} aria-labelledby="{id}-title">
  <svelte:element this={`h${level}`} id="{id}-title" class="ui-status-card-title"
    >{title}</svelte:element
  >
  <p class="ui-status-card-state"><Badge {tone}>{state}</Badge></p>
  {#if children}{@render children()}{/if}
  {#if actions}<Actions stack>{@render actions()}</Actions>{/if}
  {#if more}{@render more()}{/if}
</section>
