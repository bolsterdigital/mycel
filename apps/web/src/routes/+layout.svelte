<!-- No icon here: a tenant site shows its own logo or none, the admin a Mycel mark; a framework
     default on every route was the alternative this replaced. Each group layout sets its own. -->
<script lang="ts">
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();
</script>

{@render children()}

<style>
  /* The wrapper around %sveltekit.body% in app.html: a class, not a style attribute, because the
     CSP allows no inline styles and a nonce cannot authorise an attribute (TODO #20c). */
  :global(.sveltekit-body) {
    display: contents;
  }
</style>
