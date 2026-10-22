<script lang="ts">
  import { BLOCK_DEPTH, headingTag } from './headings.js';

  let { text }: { text: string } = $props();
</script>

<svelte:element this={headingTag(BLOCK_DEPTH)} class="block heading">{text}</svelte:element>
