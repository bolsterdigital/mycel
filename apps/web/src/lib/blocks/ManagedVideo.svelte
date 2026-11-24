<!-- The initial document holds an image and a same-site POST. The provider is only reached after
     publication and integration settings are checked again at playback. -->
<script lang="ts">
  import { ui } from '../../i18n/index.js';
  import type { RenderBlock, RenderModel } from './model.js';
  import Picture from './Picture.svelte';
  import { withBase } from './rich-text.js';
  import { IMAGE_SIZES } from './sizes.js';

  let {
    block,
    model,
    anchor,
    eager,
  }: {
    block: Extract<RenderBlock, { type: 'video' }>;
    model: RenderModel;
    anchor?: string;
    eager: boolean;
  } = $props();
  const t = $derived(ui(model.locale));
  const duration = $derived(
    block.duration === null
      ? null
      : [Math.floor(block.duration / 60), String(block.duration % 60).padStart(2, '0')].join(':')
  );
</script>

<div id={anchor} class="block video width-content">
  <figure class="video-frame">
    {#if block.play || block.poster}
      <div class="video-player">
        {#if block.poster}
          <div class="video-poster">
            <Picture image={block.poster} base={model.base} sizes={IMAGE_SIZES.content} {eager} />
            {#if duration}<span class="video-duration">{duration}</span>{/if}
          </div>
        {/if}
        {#if block.play}
          <form method="POST" action={withBase(model.base, block.play)} data-managed-video>
            <button
              type="submit"
              class="video-play managed-video-play"
              aria-label={t('video.play.title').replace('{title}', () => block.title)}
            >
              <span>{t('video.play')}</span>
            </button>
          </form>
        {/if}
      </div>
    {/if}
    {#if block.caption}<figcaption>{block.caption}</figcaption>{/if}
  </figure>
  {#if block.transcript.length}
    <details>
      <summary>{t('video.transcript')}</summary>
      {#each block.transcript as cue}<p>{cue}</p>{/each}
    </details>
  {/if}
  {#if block.maker || block.licence || block.watch}
    <div class="video-details">
      {#if block.maker || block.licence}
        <span class="video-credit">
          {model.copy.videoCredit}
          {block.maker ?? ''}
          {#if block.licence}
            · {#if block.licence.href}<a href={block.licence.href} rel="license"
                >{block.licence.label}</a
              >
            {:else}{block.licence.label}{/if}
          {/if}
        </span>
      {/if}
      {#if block.watch}<a class="video-youtube" href={block.watch}>{t('video.watch')}</a>{/if}
    </div>
  {/if}
</div>
