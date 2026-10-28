<!-- A file choice whose drop zone is the native input itself, enlarged: browsers accept a file
     dropped on a file input, so dragging works without JavaScript and the chosen name stays
     visible. Rejected: a hidden input under a styled box, which needs a script to show what was
     chosen and to accept a drop. With `preview` and JavaScript a chosen image also shows as a thumbnail
     before upload (proef 4, static/_admin/file-preview.js; the admin itself ships no client bundle). -->
<script lang="ts">
  import { ui } from '../../../i18n/index.js';
  import Field from './Field.svelte';

  let {
    id,
    name,
    label,
    locale,
    accept,
    multiple = false,
    hint,
    error,
    required = false,
    preview = false,
  }: {
    id: string;
    name: string;
    label: string;
    locale: string;
    accept?: string | undefined;
    multiple?: boolean;
    hint?: string | undefined;
    error?: string | undefined;
    required?: boolean;
    /** Thumbnails of chosen images before upload, via a small script; off keeps the page script-free. */
    preview?: boolean;
  } = $props();

  const t = $derived(ui(locale));
</script>

<Field {id} {label} {locale} hint={hint ?? t('admin.ui.file.drop')} {error} {required}>
  {#snippet control(attributes)}
    <input
      class="ui-filedrop"
      type="file"
      {name}
      {accept}
      {multiple}
      {...attributes}
      data-file-preview={preview ? t('admin.ui.file.chosen') : undefined}
    />
    {#if preview}<script type="module" src="/_admin/file-preview.js"></script>{/if}
  {/snippet}
</Field>
