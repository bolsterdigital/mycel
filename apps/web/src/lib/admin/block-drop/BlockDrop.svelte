<!-- Dropping or pasting image files on the edit screen. The script
     (`static/_admin/block-drop.js`) uploads each file through `media/upload` with its progress here,
     then asks the screen for a block at the place of the drop: the same `insert` action as the
     block chooser, with the uploaded ids, so the save of what was typed comes first. An article's
     writer places images itself, between its paragraphs. Hidden and inert without JavaScript: the
     chooser and the media picker are the route then, and stay the keyboard's route too. Rejected:
     an overlay over the whole screen as on the media page, which would hide the place it inserts,
     and results pinned to the window, which covered the item bar's Save on a phone. -->
<script lang="ts">
  import { GALLERY_ROWS, MAX_UPLOAD_BYTES } from '@mycel/core';
  import { formatBytes } from '#lib/admin/format.js';
  import { fill, ui } from '../../../i18n/index.js';

  let {
    base,
    locale,
    work,
    article,
  }: {
    /** The tenant's admin path, `/admin/<slug>`. */
    base: string;
    /** The language of the admin. */
    locale: string;
    /** The content locale on screen, which the insert action comes back in. */
    work: string;
    /** An article: its writer places each image as its own block, a page gets one gallery. */
    article: boolean;
  } = $props();
  const t = $derived(ui(locale));
  const copy = $derived(
    JSON.stringify({
      here: t('admin.block.drop.here'),
      end: t('admin.block.drop.end'),
      uploading: t('admin.media.picker.uploading'),
      uploaded: t('admin.media.done.uploaded'),
      failed: t('admin.media.picker.failed'),
      notImage: t('admin.block.drop.notImage'),
      tooMany: t('admin.block.drop.tooMany'),
    })
  );
</script>

<div
  class="block-drop"
  data-block-drop
  data-url="{base}/media/upload"
  data-max-images={GALLERY_ROWS}
  data-copy={copy}
  hidden
>
  <div class="block-drop-prompt" data-block-drop-prompt hidden>
    <strong data-block-drop-where></strong>
    <p>
      {fill(t('admin.block.drop.hint'), { max: formatBytes(MAX_UPLOAD_BYTES, locale) })}
      {article ? t('admin.block.drop.separate') : t('admin.block.drop.gallery')}
    </p>
  </div>
  <div data-block-drop-results hidden>
    <ul class="ui-media-uploads" data-block-drop-progress aria-live="polite"></ul>
    <div class="ui-actions">
      <button type="button" class="ui-button" data-block-drop-place hidden
        >{t('admin.block.drop.place')}</button
      >
      <button type="button" class="ui-button secondary" data-block-drop-dismiss
        >{t('admin.block.drop.dismiss')}</button
      >
    </div>
  </div>
  <p class="ui-visually-hidden" aria-live="polite" data-block-drop-announcement></p>
  <input type="hidden" name="insertMedia" value="" data-block-drop-media disabled />
  <button
    type="submit"
    formaction="?/insert&locale={work}"
    formnovalidate
    name="insert"
    value=""
    hidden
    data-block-drop-submit>{t('admin.block.drop.place')}</button
  >
</div>

<style>
  /* A grid item between the block cards, and like them it must not widen the column: at 320 px
     and 200% text the bold "Uploadresultaten" of the media page's dismiss label was wider than
     the screen, and its min-content stretched every card (CI's DejaVu Sans; the Mac's narrower
     font hid it). Hence also this panel's own shorter label, which no word break cuts. */
  .block-drop {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-1);
    min-inline-size: 0;
  }
  .block-drop[hidden],
  .block-drop [hidden] {
    display: none;
  }
  /* The prompt while dragging only: pinned to the bottom, so the place of the drop stays in view
     above it. The results stay in the page, where they cover no control. */
  .block-drop-prompt {
    position: fixed;
    inset-inline: var(--space-2);
    inset-block-end: var(--space-2);
    z-index: 90;
    max-inline-size: 36rem;
    margin-inline: auto;
    pointer-events: none;
  }
  .block-drop-prompt,
  [data-block-drop-results] {
    padding: var(--space-2);
    background: var(--color-surface-bg);
    color: var(--color-surface-fg);
    border: var(--border-width) solid var(--color-border-strong);
    border-radius: var(--radius);
    overflow-wrap: anywhere;
  }
  .block-drop-prompt {
    box-shadow: var(--shadow-2);
  }
  .block-drop-prompt p {
    margin: var(--space-0) 0 0;
  }
  /* The line between two blocks where the image goes: on the card's edge, never moving it. */
  :global([data-drop-at='before']) {
    box-shadow: 0 calc(-1 * var(--space-0)) 0 0 var(--color-link);
  }
  :global([data-drop-at='after']) {
    box-shadow: 0 var(--space-0) 0 0 var(--color-link);
  }
</style>
