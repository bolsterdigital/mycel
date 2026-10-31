<!-- What a list shows when it has nothing yet: what will appear here and the one action that
     fills it, optionally under an icon that says what kind of list it is (#116). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from '../Icon.svelte';
  import type { IconName } from '../icons.js';

  let {
    title,
    level = 2,
    icon,
    children,
    action,
  }: {
    title: string;
    level?: 2 | 3;
    icon?: IconName | undefined;
    children?: Snippet;
    action?: Snippet;
  } = $props();
</script>

<div class="ui-empty">
  {#if icon}<span class="ui-empty-icon"><Icon name={icon} /></span>{/if}
  <svelte:element this={`h${level}`} class="ui-empty-title">{title}</svelte:element>
  {#if children}{@render children()}{/if}
  {#if action}{@render action()}{/if}
</div>
