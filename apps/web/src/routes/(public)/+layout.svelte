<script lang="ts">
  import '#lib/theme/base.css';
  import MycelCredit from '#lib/components/MycelCredit.svelte';
  import type { LayoutProps } from './$types';

  let { children, data }: LayoutProps = $props();
</script>

<svelte:head>
  {#if data.theme}
    {#each data.theme.preload as font (font)}
      <link rel="preload" href={font} as="font" type="font/woff2" crossorigin="anonymous" />
    {/each}
    <link rel="stylesheet" href={data.theme.href} />
  {/if}
</svelte:head>

{@render children()}
{#if data.credit}<MycelCredit {...data.credit} />{/if}
