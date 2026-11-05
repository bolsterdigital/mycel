<!-- The big title field of the edit screen. A new item's stored title is a stand-in (P185-79): the
     field is empty with the stand-in as placeholder and a marker that keeps it stored when a save
     leaves the field empty (`valuesFromForm`), so nothing has to be deleted before typing.
     Rejected: storing no title, which core's documents require. -->
<script lang="ts">
  import { ui } from '../../i18n/index.js';

  let {
    locale,
    label,
    value,
    required,
  }: { locale: string; label: string; value: string; required: boolean } = $props();

  const untitled = $derived(value === ui(locale)('admin.content.untitled'));
</script>

<div class="ui-field">
  <label class="ui-visually-hidden" for="title.{locale}">{label}</label>
  <input
    class="ui-title-input"
    size="1"
    id="title.{locale}"
    name="title.{locale}"
    type="text"
    maxlength="200"
    required={required && !untitled}
    value={untitled ? '' : value}
    placeholder={untitled ? value : undefined}
    lang={locale}
  />
  {#if untitled}<input type="hidden" name="untitled" value={locale} />{/if}
</div>
