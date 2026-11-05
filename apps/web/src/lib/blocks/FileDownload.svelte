<!-- A list of files to download, one row each with the icon of the audio block's download. The label
     is the link, so a screen reader's list of links reads as a list of documents; the kind and size
     stand beside it. Nothing left to fetch: nothing at all, no heading above an empty list. -->
<script lang="ts">
  import DownloadIcon from './DownloadIcon.svelte';
  import { BLOCK_DEPTH, headingTag } from './headings.js';
  import type { RenderBlock, RenderModel } from './model.js';
  import { withBase } from './rich-text.js';

  let {
    block,
    model,
  }: { block: Extract<RenderBlock, { type: 'file-download' }>; model: RenderModel } = $props();
</script>

{#if block.files.length}
  <section class="block file-download">
    {#if block.title}<svelte:element this={headingTag(BLOCK_DEPTH)}>{block.title}</svelte:element
      >{/if}
    {#if block.body}<p>{block.body}</p>{/if}
    <ul>
      {#each block.files as file, i (i)}
        <li>
          <DownloadIcon />
          <a href={withBase(model.base, file.href)} download>{file.label}</a>
          <span class="file-download-meta">{file.meta}</span>
        </li>
      {/each}
    </ul>
  </section>
{/if}
