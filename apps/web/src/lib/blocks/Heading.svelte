<script lang="ts">
  import { BLOCK_DEPTH, headingTag } from './headings.js';

  let { text, anchor }: { text: string; anchor?: string } = $props();
</script>

<svelte:element this={headingTag(BLOCK_DEPTH)} id={anchor} class="block heading"
  >{text}</svelte:element
>
