<script lang="ts">
  import '#lib/theme/base.css';
  import '#lib/theme/admin.css';
  import '#lib/admin/ui/ui.css';
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();
</script>

<svelte:head>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

{@render children()}
