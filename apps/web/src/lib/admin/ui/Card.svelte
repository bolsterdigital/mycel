<!-- A card: optional media on top, a heading, a body and a footer. With `href` the heading is the
     one link and its hit area stretches over the card, so the card has a single tab stop and a
     clear accessible name. Rejected: wrapping the whole card in <a>, which reads every word of
     it as the link text and forbids buttons inside. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    href,
    level = 3,
    media,
    children,
    footer,
  }: {
    title: string;
    href?: string | undefined;
    level?: 2 | 3 | 4;
    media?: Snippet;
    children?: Snippet;
    footer?: Snippet;
  } = $props();
</script>

<article class={['ui-card', href && 'linked']}>
  {#if media}<div class="ui-card-media">{@render media()}</div>{/if}
  <div class="ui-card-body">
    <svelte:element this={`h${level}`} class="ui-card-title">
      {#if href}<a {href}>{title}</a>{:else}{title}{/if}
    </svelte:element>
    {#if children}{@render children()}{/if}
  </div>
  {#if footer}<div class="ui-card-footer">{@render footer()}</div>{/if}
</article>
