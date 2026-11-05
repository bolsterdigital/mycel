<!-- One sound file with the browser's own player: it works without a script, by keyboard and on a
     phone's lock screen. The download link and the transcript stand beside it, for whoever cannot
     or does not want to listen. A restricted, deleted or failed file renders nothing. -->
<script lang="ts">
  import { BLOCK_DEPTH, headingTag } from './headings.js';
  import type { RenderBlock, RenderModel } from './model.js';
  import { withBase } from './rich-text.js';

  let { block, model }: { block: Extract<RenderBlock, { type: 'audio' }>; model: RenderModel } =
    $props();
</script>

{#if block.file}
  <section class="block audio">
    <svelte:element this={headingTag(BLOCK_DEPTH)}>{block.title}</svelte:element>
    <audio
      controls
      preload="metadata"
      src={withBase(model.base, block.file.href)}
      aria-label={block.title}
    ></audio>
    <p>
      <a href={withBase(model.base, block.file.href)} download>{model.copy.audioDownload}</a>
      <span class="file-download-meta">({block.file.meta})</span>
    </p>
    {#if block.transcript}
      <details>
        <summary>{model.copy.audioTranscript}</summary>
        <p class="audio-transcript">{block.transcript}</p>
      </details>
    {/if}
  </section>
{/if}
