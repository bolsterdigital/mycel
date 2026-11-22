<script lang="ts">
  import { headingTag } from './headings.js';

  let { text, anchor, depth }: { text: string; anchor?: string; depth: number } = $props();
</script>

<svelte:element this={headingTag(depth + 1)} id={anchor} class="block heading"
  >{text}</svelte:element
>
