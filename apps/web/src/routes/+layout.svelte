<script lang="ts">
  import favicon from '#lib/assets/favicon.svg';
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

<style>
  /* The wrapper around %sveltekit.body% in app.html: a class, not a style attribute, because the
     CSP allows no inline styles and a nonce cannot authorise an attribute (TODO #20c). */
  :global(.sveltekit-body) {
    display: contents;
  }
</style>
