<!-- A link to the provider: no thumbnail (external images fall outside img-src 'self'). Where the
     site placed this provider (embeds.ts), a play button sits above the link, hidden until
     `static/_site/embed.js` shows it; a click puts the player in its place. Without JavaScript,
     or with the provider off, the link is all there is. Rejected: a visible button in the HTML,
     which would do nothing without the script. -->
<script lang="ts">
  import { placedEmbeds } from './embeds.js';
  import { VIDEO_PROVIDER_NAMES, type RenderBlock, type RenderModel } from './model.js';

  let {
    block,
    model,
    anchor,
  }: { block: Extract<RenderBlock, { type: 'video-embed' }>; model: RenderModel; anchor?: string } =
    $props();

  const placed = placedEmbeds();
  const provider = $derived(VIDEO_PROVIDER_NAMES[block.provider]);
</script>

<figure id={anchor} class="block video width-{block.width}">
  {#if placed.includes(block.provider)}
    <div class="video-player" data-embed-src={block.player} data-embed-title={block.title} hidden>
      <button type="button" class="video-play"
        >{model.copy.videoPlay
          .replace('{title}', () => block.title)
          .replace('{provider}', provider)}</button
      >
    </div>
  {/if}
  <p class="video-link">
    <a href={block.url}>{block.title}</a>
    <span class="video-provider">{model.copy.videoOn.replace('{provider}', provider)}</span>
  </p>
  {#if block.caption}<figcaption>{block.caption}</figcaption>{/if}
</figure>
