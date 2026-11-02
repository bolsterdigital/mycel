<!-- A window-wide file drop enhancement for a library. The native upload dialog remains the
     keyboard and no-script path; an overlay only appears for files, never for dragged links.
     Rejected: a permanent drop field above the library, which hides the content people came for. -->
<script lang="ts">
  import AdminScript from '../../trusted/AdminScript.svelte';
  import { ui } from '../../../../i18n/index.js';

  let { url, locale, hint }: { url: string; locale: string; hint: string } = $props();
  const t = $derived(ui(locale));
  const copy = $derived(
    JSON.stringify({
      uploading: t('admin.media.picker.uploading'),
      uploaded: t('admin.media.done.uploaded'),
      failed: t('admin.media.picker.failed'),
      open: t('admin.media.done.open'),
      refresh: t('admin.media.upload.refresh'),
    })
  );
</script>

<div data-upload-dropzone data-url={url} data-copy={copy}>
  <div class="ui-upload-overlay" data-upload-overlay hidden>
    <div class="ui-upload-prompt">
      <strong>{t('admin.media.upload.drop')}</strong>
      <p>{hint}</p>
    </div>
  </div>
  <div data-upload-results hidden>
    <div class="ui-actions">
      <button type="button" class="ui-button secondary" data-upload-dismiss
        >{t('admin.media.upload.dismiss')}</button
      >
    </div>
    <ul
      class="ui-media-uploads"
      data-upload-progress
      aria-live="polite"
      aria-relevant="additions text"
    ></ul>
  </div>
  <p class="ui-visually-hidden" aria-live="polite" data-upload-announcement></p>
</div>
<AdminScript src="/_admin/drop-upload.js" />
