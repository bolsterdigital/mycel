<!-- The bar on top of an item's edit screen (brief edit-screen § 4): back to the list, the one
     <h1>, the item's state in words and its actions (save, preview, the main action). It replaces
     the page header there, so the actions sit in one place on every item. The actions are buttons
     of the edit form through `form=`, so the bar may stand outside it. Without a script it is an
     ordinary bar on top; the edit-screen script of #66 PR 6 may make it stick. The actions wrap
     as whole buttons (skill ui-action-layout). Rejected: the breadcrumb and page header of the
     other screens, which put the title twice and the actions under a line of ids. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Badge from './Badge.svelte';
  import Icon from './Icon.svelte';

  let {
    back,
    title,
    state,
    stateHref,
    tone = 'neutral',
    level = 1,
    actions,
  }: {
    /** The list this item belongs to. */
    back: { href: string; label: string };
    title: string;
    /** The item's state in words ("Concept", "Gepubliceerd, sindsdien gewijzigd"). */
    state?: string | undefined;
    /** Where the state is explained and acted on (the status card), one tap from the bar. */
    stateHref?: string | undefined;
    tone?: 'neutral' | 'info' | 'success' | 'warning' | 'error';
    /** 1 on the edit screen; lower only where the bar is shown as a sample (the catalogue). */
    level?: 1 | 2 | 3;
    actions?: Snippet;
  } = $props();
</script>

<header class="ui-item-bar">
  <div class="ui-item-bar-where">
    <a class="ui-item-bar-back" href={back.href}><Icon name="arrow-left" />{back.label}</a>
    <svelte:element this={`h${level}`} class="ui-item-bar-title">{title}</svelte:element>
    {#if state && stateHref}<a class="ui-item-bar-state" href={stateHref}
        ><Badge {tone}>{state}</Badge></a
      >{:else if state}<Badge {tone}>{state}</Badge>{/if}
  </div>
  {#if actions}
    <div class="ui-actions-host">
      <div class="ui-actions end">{@render actions()}</div>
    </div>
  {/if}
</header>
