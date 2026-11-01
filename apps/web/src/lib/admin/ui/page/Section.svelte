<!-- A section of an overview screen (#116, after Jaap's background-tasks mockup of 2026-10-31): a
     heading, beside it a count in muted text when the section lists something, one line of what it
     is under it, then the content, usually a card (StatusLine, a list of rows, a table). Longer
     explanation waits behind an ⓘ beside the heading (HintButton, the same pattern as a field's
     hint), so it works without JavaScript and is out of the way once read. The spacing between
     heading, line and content belongs to the section, not to whatever follows the heading.
     Rejected: SettingsSection (a form with a save button) and a loose <h2> per screen, which left
     every screen to space its own heading and let a card touch the heading above it. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import HintButton from '../feedback/HintButton.svelte';

  let {
    id,
    title,
    intro,
    info,
    count,
    locale,
    level = 2,
    children,
  }: {
    /** The section's id; the heading is `{id}-title`. */
    id: string;
    title: string;
    /** One line under the heading. */
    intro?: string | undefined;
    /** Longer explanation behind an ⓘ beside the heading. */
    info?: string | undefined;
    /** Beside the heading, muted: "3 tasks". */
    count?: string | undefined;
    locale: string;
    level?: 2 | 3;
    children: Snippet;
  } = $props();
</script>

<section class="ui-overview-section" {id} aria-labelledby="{id}-title">
  <div class="ui-overview-section-head">
    <svelte:element this={`h${level}`} id="{id}-title">{title}</svelte:element>
    {#if info}<HintButton target="{id}-info" labelId="{id}-title" {locale} />{/if}
    {#if count}<span class="ui-overview-section-count">{count}</span>{/if}
  </div>
  {#if info}<p class="ui-hint" id="{id}-info" popover>{info}</p>{/if}
  {#if intro}<p class="ui-overview-section-intro">{intro}</p>{/if}
  {@render children()}
</section>
