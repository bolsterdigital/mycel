<!-- The poster and the player share a frame with the caption. A real link handles playback
     until the managed embed script can replace it with a button. External posters would
     contact the provider before playback, so posters come from the site's media library. -->
<script lang="ts">
  import { placedEmbeds } from './embeds.js';
  import { VIDEO_PROVIDER_NAMES, type RenderBlock, type RenderModel } from './model.js';
  import Picture from './Picture.svelte';
  import { withBase } from './rich-text.js';
  import { IMAGE_SIZES } from './sizes.js';

  let {
    block,
    model,
    anchor,
    eager,
  }: {
    block: Extract<RenderBlock, { type: 'video-embed' }>;
    model: RenderModel;
    anchor?: string;
    eager: boolean;
  } = $props();

  const placed = placedEmbeds();
  const playLabel = $derived(
    model.copy.videoPlay
      .replace('{title}', () => block.title)
      .replace('{provider}', VIDEO_PROVIDER_NAMES[block.provider])
  );
  const duration = $derived(
    block.duration === null
      ? null
      : [Math.floor(block.duration / 60), String(block.duration % 60).padStart(2, '0')].join(':')
  );
</script>

<div id={anchor} class="block video width-{block.width}">
  <figure class="video-frame">
    <div
      class="video-player"
      class:has-poster={block.poster}
      {...placed.includes(block.provider)
        ? { 'data-embed-src': block.player, 'data-embed-title': block.title }
        : {}}
    >
      {#if block.poster}
        <div class="video-poster">
          <Picture
            image={block.poster}
            base={model.base}
            sizes={IMAGE_SIZES[block.width]}
            {eager}
          />
          {#if duration}<span class="video-duration">{duration}</span>{/if}
        </div>
      {/if}
      <a class="video-link" href={block.url}>
        <span class="video-label">{block.title}</span>
      </a>
      {#if placed.includes(block.provider)}
        <button type="button" class="video-play" aria-label={playLabel} hidden>
          <span class="video-label">{block.title}</span>
        </button>
      {/if}
    </div>
    {#if block.caption}<figcaption>{block.caption}</figcaption>{/if}
  </figure>
  {#if block.maker || block.licence || block.youtube || block.page}
    <div class="video-details">
      {#if block.maker || block.licence}
        <span class="video-credit">
          <svg
            class="credit-icon"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="6" width="13" height="12" rx="2" />
            <path d="m15 10 7-4v12l-7-4z" />
          </svg>
          <span class="credit-word">{model.copy.videoCredit}</span>
          {#if block.maker}
            {#if block.maker.href}<a href={block.maker.href}>{block.maker.label}</a>{:else}{block
                .maker.label}{/if}
          {/if}
          {#if block.maker && block.licence}
            ·
          {/if}
          {#if block.licence}
            <span class="credit-licence"
              >{#if block.licence.href}<a href={block.licence.href} rel="license"
                  >{block.licence.label}</a
                >{:else}{block.licence.label}{/if}</span
            >
          {/if}
        </span>
      {/if}
      {#if block.page}<a href={withBase(model.base, block.page)}>{block.title}</a>{/if}
      {#if block.youtube}
        <a class="video-youtube" href={block.youtube}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="1" y="4" width="22" height="16" rx="5" />
            <path fill="currentColor" d="m10 9 5 3-5 3z" />
          </svg>
          {model.copy.videoYouTube}
        </a>
      {/if}
    </div>
  {/if}
</div>
