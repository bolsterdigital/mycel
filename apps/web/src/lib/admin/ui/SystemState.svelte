<!-- A state of the system instead of the content a screen expected (brief #56 § B): loading,
     empty, an error, no access, signed out. The state is in the words, the mark only repeats it.
     As a whole page (`page`) it is the screen's <main> with the one <h1>; inside a screen it is a
     region under an <h2>. Loading is announced politely; nothing else interrupts, because a page
     that opens on a state is read as content. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Kind = 'loading' | 'empty' | 'error' | 'forbidden' | 'signed-out';

  let {
    kind,
    title,
    page = false,
    children,
    action,
  }: {
    kind: Kind;
    title: string;
    page?: boolean;
    children?: Snippet;
    action?: Snippet;
  } = $props();
</script>

{#snippet body()}
  <div class={['ui-state', kind]} role={kind === 'loading' ? 'status' : undefined}>
    <svelte:element this={page ? 'h1' : 'h2'} class="ui-state-title">{title}</svelte:element>
    {#if children}{@render children()}{/if}
    {#if action}<div class="ui-state-action">{@render action()}</div>{/if}
  </div>
{/snippet}

{#if page}
  <main class="page admin ui-state-page">{@render body()}</main>
{:else}
  {@render body()}
{/if}
