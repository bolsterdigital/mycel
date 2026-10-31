<!-- The state of a site's work in one verdict (brief admin-operations-screens § 1): a heading that
     says it in words ("Everything is running", "2 things need attention"), the moment it was
     established, and per point what it is and what to do, linked to the place where it can be
     done. The tone only repeats the words. `unknown` is its own tone, for a status that could not
     be read: it is never drawn as `ok`. The status page and the dashboard show the same summary,
     so "attention" means one thing in both. Rejected: a coloured dot or a number alone (the state
     would be in the colour) and a live region on the heading (a page that opens on it reads it
     as content; the refresh script announces a change itself). Since #116 it has the form of a
     StatusLine: in a white card, a mark per tone, the verdict, and the moment on the right. The
     three marks are all in the markup and the tone class shows one, so the refresh script, which
     only changes that class and the heading, changes the mark with it. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { When } from '../../format.js';
  import Icon from '../Icon.svelte';

  let {
    id,
    title,
    tone,
    checked,
    checkedLabel,
    items = [],
    level = 2,
    children,
  }: {
    id: string;
    /** The verdict in words. */
    title: string;
    tone: 'ok' | 'attention' | 'unknown';
    /** When the verdict was established. */
    checked: When;
    /** The words before the moment: "Checked". */
    checkedLabel: string;
    /** What asks for attention: what it is, what to do, where. */
    items?: { label: string; action: string; href: string }[];
    level?: 2 | 3;
    /** Under the points: the refresh control, a note. */
    children?: Snippet;
  } = $props();
</script>

<section class={['ui-status-summary', tone]} {id} aria-labelledby="{id}-title">
  <div class="ui-status-summary-head">
    <span class="ui-status-mark"
      ><span class="ok"><Icon name="circle-check" /></span><span class="attention"
        ><Icon name="triangle-alert" /></span
      ><span class="unknown"><Icon name="circle-help" /></span></span
    >
    <svelte:element this={`h${level}`} id="{id}-title" class="ui-status-summary-title"
      >{title}</svelte:element
    >
    <p class="ui-status-summary-checked">
      {checkedLabel}
      <time datetime={checked.iso} title={checked.full}>{checked.text}</time>
    </p>
  </div>
  {#if items.length}
    <ul class="ui-status-summary-items">
      {#each items as item (item.href)}
        <li><a href={item.href}>{item.label}</a> {item.action}</li>
      {/each}
    </ul>
  {/if}
  {#if children}{@render children()}{/if}
</section>
