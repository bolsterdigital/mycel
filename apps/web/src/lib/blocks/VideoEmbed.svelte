<!-- A plain link to the provider: no iframe, no thumbnail (external images fall outside
     img-src 'self'), no script. The embed is a later, explicit enhancement. -->
<script lang="ts">
  import { VIDEO_PROVIDER_NAMES, type RenderBlock, type RenderModel } from './model.js';

  let {
    block,
    model,
  }: { block: Extract<RenderBlock, { type: 'video-embed' }>; model: RenderModel } = $props();
</script>

<figure class="block video width-{block.width}">
  <p class="video-link">
    <a href={block.url}>{block.title}</a>
    <span class="video-provider"
      >{model.copy.videoOn.replace('{provider}', VIDEO_PROVIDER_NAMES[block.provider])}</span
    >
  </p>
  {#if block.caption}<figcaption>{block.caption}</figcaption>{/if}
</figure>
