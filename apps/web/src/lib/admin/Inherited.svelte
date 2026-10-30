<!-- What an empty field of the edit screen falls back to (#86, brief content-images-and-summaries
     table stake 3): "Default: the hero image" with its thumbnail, "Default: the first paragraph:
     'After three years…'". The value and its source come from core's chain (`effective` of
     `content.item.get`), so the screen never derives it on its own. One component for images and
     texts; the page shows it only while the field is empty. Rejected: a placeholder in the field
     (gone the moment one types, not read by every screen reader, and no room for an image), and a
     component in lib/admin/ui (it knows the chain's sources, which are content's words). -->
<script lang="ts">
  import { fill, ui, type UiKey } from '../../i18n/index.js';

  let {
    id,
    locale,
    kind,
    source,
    text = null,
    thumb = null,
  }: {
    id: string;
    locale: string;
    kind: 'image' | 'text';
    /** The link of the chain the value came from; null when the chain has nothing. */
    source: string | null;
    text?: string | null;
    /** The thumbnail of an inherited image, when it has one. */
    thumb?: string | null;
  } = $props();

  const t = $derived(ui(locale));
</script>

<p class="ui-inherited" {id}>
  {#if thumb}<img src={thumb} alt="" width="48" height="48" />{/if}
  <span
    >{source
      ? fill(t('admin.content.inherited'), {
          source: t(`admin.content.inherited.${kind}.${source}` as UiKey),
        })
      : t('admin.content.inherited.empty')}{#if source && text}: <q>{text}</q>{/if}</span
  >
</p>
