<!-- A media article's recording on top (ADR 025, amended 2026-11-27; MY-305): the managed video
     block at the stage's width, and beside it on a wide screen, under it on a narrow one, the
     transcript to read along. Without JavaScript the transcript is a list with a visible start
     time per line, in a scrolling panel that takes the keyboard. `/_site/read-along.js` makes each
     line a button that seeks, follows the playback, searches, links to a moment and switches the
     captions; its controls stay hidden until it runs, since none of them can work without it.
     The words for its states travel as data attributes, so the script carries no copy (ADR 007).
     Chapters (MY-305 PR 2) sit under the player as a compact list: without JavaScript start times
     and titles, with it each becomes a button that seeks, and the one that plays is current.
     Under the player first its own controls on one row, then the chapters; the panel's title and
     search share a row, and its find buttons and "back to now" only appear when they can act.
     While it plays and the reader scrolls past it, the script docks the player in a corner with a
     close button (`is-docked` on the stage; the frame is never moved, which would reload it).
     Rejected: a live region for the running text (a screen reader would talk over the recording),
     links per line (`?t=` starts at a moment only with the script; without it is a reload) and a
     chapters tab beside the read-along (the same list twice, one of them hidden). -->
<script lang="ts">
  import { ui } from '../../i18n/index.js';
  import ManagedVideo from './ManagedVideo.svelte';
  import { blockAnchor } from './anchor.js';
  import { clockTime, isoDuration } from './recording.js';
  import type { RenderBlock, RenderModel } from './model.js';

  let {
    recording,
    model,
  }: { recording: Extract<RenderBlock, { type: 'video' }>; model: RenderModel } = $props();
  const t = $derived(ui(model.locale));
  const id = $derived(`read-along-${recording.id}`);
  const modes = ['showing', 'hidden', 'disabled'] as const;
</script>

<div
  class="media-stage layout-wide"
  class:with-transcript={recording.transcript.length > 0}
  data-media-stage
>
  <div class="media-stage-player">
    <ManagedVideo block={recording} {model} anchor={blockAnchor(recording.id)} eager header>
      {#snippet below()}
        {#if recording.play && recording.transcript.length}
          <p class="media-caption-line" data-caption-line hidden></p>
        {/if}
      {/snippet}
    </ManagedVideo>
    {#if recording.play}
      <button type="button" class="media-undock" data-undock hidden>{t('video.dock.close')}</button>
      <div class="media-controls" data-media-controls hidden>
        {#if recording.transcript.length}
          <fieldset class="caption-modes">
            <legend>{t('video.captions.mode')}</legend>
            {#each modes as mode (mode)}
              <label
                ><input type="radio" name="{id}-captions" value={mode} />
                {t(`video.captions.${mode}`)}</label
              >
            {/each}
          </fieldset>
        {/if}
        <div class="media-share">
          <button
            type="button"
            class="button secondary"
            data-share
            data-label={t('video.share')}
            data-copied={t('video.share.copied')}
            >{t('video.share').replace('{time}', () => clockTime(0))}</button
          >
          <p role="status" class="media-share-status" data-share-status></p>
        </div>
      </div>
    {/if}
    {#if recording.chapters.length}
      <section class="media-chapters" aria-labelledby="{id}-chapters" data-chapters>
        <h2 id="{id}-chapters">{t('video.chapters')}</h2>
        <ol>
          {#each recording.chapters as chapter, index (index)}
            <li data-start={chapter.start}>
              <time datetime={isoDuration(chapter.start)}>{clockTime(chapter.start)}</time>
              <span class="media-chapter-title">{chapter.title}</span>
            </li>
          {/each}
        </ol>
      </section>
    {/if}
  </div>
  {#if recording.transcript.length}
    <section class="read-along" aria-labelledby="{id}-title" data-read-along>
      <div class="read-along-head">
        <h2 id="{id}-title">{t('video.readAlong')}</h2>
        <div class="read-along-search" data-read-along-search hidden>
          <label class="read-along-label" for="{id}-query">{t('video.readAlong.search')}</label>
          <input
            id="{id}-query"
            type="search"
            autocomplete="off"
            spellcheck="false"
            placeholder={t('video.readAlong.search')}
          />
        </div>
        <div class="read-along-find" data-read-along-find hidden>
          <p
            role="status"
            class="read-along-count"
            data-count={t('video.readAlong.count')}
            data-none={t('video.readAlong.none')}
          ></p>
          <button type="button" class="button secondary" data-find="previous"
            >{t('video.readAlong.previous')}</button
          >
          <button type="button" class="button secondary" data-find="next"
            >{t('video.readAlong.next')}</button
          >
        </div>
      </div>
      <button type="button" class="button secondary read-along-now" data-read-along-now hidden
        >{t('video.readAlong.now')}</button
      >
      <!-- svelte-ignore a11y_no_noninteractive_tabindex: a scrolling region must be reachable by keyboard (axe scrollable-region-focusable); the script removes it once the lines are buttons -->
      <ol class="read-along-lines" tabindex="0" aria-labelledby="{id}-title">
        {#each recording.transcript as cue, index (index)}
          <li data-start={cue.start} data-end={cue.end}>
            <time datetime={isoDuration(cue.start)}>{clockTime(cue.start)}</time>
            {#if cue.speaker}<span class="read-along-speaker">{cue.speaker}</span>{/if}
            <span class="read-along-text">{cue.text}</span>
          </li>
        {/each}
      </ol>
    </section>
  {/if}
</div>
