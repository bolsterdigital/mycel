<!-- A value someone copies into another system (a DNS record at their provider, brief #81): a
     label, the value in a <code> that a click selects whole and that wraps anywhere at 320 CSS px,
     and a copy button that static/_admin/copy.js reveals when the clipboard is available, as in
     KeyReveal. The button's accessible name is its own text plus the label, so a row of four
     records does not offer four equal "Copy" buttons (WCAG 2.4.6) and the name follows the text
     when the script changes it to "Copied". Rejected: a readonly <input> (a long TXT value scrolls
     out of view inside it) and an <output> (an implicit status role: one live region per record,
     and a second "status" next to the page's notice). -->
<script lang="ts">
  import AdminScript from '../../AdminScript.svelte';
  import { ui } from '../../../../i18n/index.js';

  let {
    id,
    label,
    value,
    locale,
  }: {
    id: string;
    label: string;
    value: string;
    locale: string;
  } = $props();

  const t = $derived(ui(locale));
</script>

<svelte:head><AdminScript src="/_admin/copy.js" /></svelte:head>

<div class="ui-copy-field">
  <span class="ui-copy-label" id="{id}-label">{label}</span>
  <div class="ui-copy">
    <code class="ui-copy-value" {id}>{value}</code>
    <button
      class="ui-button secondary"
      type="button"
      hidden
      id="{id}-copy"
      aria-labelledby="{id}-copy {id}-label"
      data-copy={id}
      data-copied={t('admin.ui.copy.done')}
      data-failed={t('admin.ui.copy.failed')}>{t('admin.ui.copy')}</button
    >
  </div>
</div>
