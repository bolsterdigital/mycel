<!-- The initial document holds an image and a same-site POST. The provider is only reached after
     publication and integration settings are checked again at playback. Without JavaScript the
     form opens the player page; with it `/_site/managed-video.js` plays the grant in this place,
     with the words it needs as data attributes (ADR 007). A `?t=`
     moment on the recording on top travels as a hidden `t` (MY-305). As a media article's
     recording on top (`header`, MY-305) it fills the header's stage and leaves the transcript to
     the read-along beside it; `below` sits directly under the picture. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
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
    header = false,
    below,
  }: {
    block: Extract<RenderBlock, { type: 'video' }>;
    model: RenderModel;
    anchor?: string;
    eager: boolean;
    header?: boolean;
    below?: Snippet;
  } = $props();
  const t = $derived(ui(model.locale));
  // The readable line as the transcript always read: the speaker's name before what they say.
  const line = (cue: (typeof block.transcript)[number]) =>
    cue.speaker ? `${cue.speaker}: ${cue.text}` : cue.text;
  // Minutes past the hour stay minutes (`41:00`, `75:10`), as the block always showed them.
  const duration = $derived(
    block.duration === null
      ? null
      : [Math.floor(block.duration / 60), String(block.duration % 60).padStart(2, '0')].join(':')
  );
</script>

<div id={anchor} class={header ? 'video media-recording' : 'block video width-content'}>
  <figure class="video-frame">
    {#if block.play || block.poster}
      <div class="video-player">
        {#if block.poster}
          <div class="video-poster">
            <Picture
              image={block.poster}
              base={model.base}
              sizes={header ? IMAGE_SIZES.wide : IMAGE_SIZES.content}
              {eager}
            />
            {#if duration}<span class="video-duration">{duration}</span>{/if}
          </div>
        {/if}
        {#if block.play}
          <form
            method="POST"
            action={withBase(model.base, block.play)}
            data-managed-video
            data-title={block.title}
            data-lang={model.locale}
            data-captions={t('video.captions')}
            data-unavailable={t('video.unavailable')}
          >
            {#if block.start}<input type="hidden" name="t" value={block.start} />{/if}
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
  {@render below?.()}
  {#if block.transcript.length && !header}
    <details>
      <summary>{t('video.transcript')}</summary>
      {#each block.transcript as cue, index (index)}<p>{line(cue)}</p>{/each}
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
