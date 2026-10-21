<script lang="ts">
  import '#lib/theme/base.css';
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();
</script>

{@render children()}
