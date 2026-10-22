<script lang="ts">
  import '#lib/theme/base.css';
  import MycelCredit from '#lib/components/MycelCredit.svelte';
  import type { LayoutProps } from './$types';

  let { children, data }: LayoutProps = $props();
</script>

{@render children()}
{#if data.credit}<MycelCredit {...data.credit} />{/if}
