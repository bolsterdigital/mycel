<!-- A secret shown once (an API key's token, brief #81): the value in an <output> that a click
     selects whole, the sentence that it will not be shown again, and a copy button that
     static/_admin/copy.js reveals when the clipboard is available. Without that script the
     button stays hidden and selecting plus copying by hand is the whole path. Rejected: a
     readonly <input> (a token that does not fit scrolls out of view inside it at 320 CSS px) and
     a <dialog open> (not modal without a script, and the token belongs to the page that made it). -->
<script lang="ts">
  import AdminScript from '../../AdminScript.svelte';
  import type { Snippet } from 'svelte';
  import { ui } from '../../../../i18n/index.js';

  let {
    id,
    title,
    value,
    locale,
    children,
  }: {
    id: string;
    title: string;
    /** The secret itself. */
    value: string;
    locale: string;
    /** What happens after this, below the sentence that it is shown once. */
    children?: Snippet;
  } = $props();

  const t = $derived(ui(locale));
</script>

<svelte:head><AdminScript src="/_admin/copy.js" /></svelte:head>

<section class="ui-reveal" aria-labelledby="{id}-title">
  <h2 id="{id}-title">{title}</h2>
  <p>{t('admin.ui.reveal.once')}</p>
  {#if children}{@render children()}{/if}
  <div class="ui-copy">
    <output class="ui-copy-value" id="{id}-value">{value}</output>
    <button
      class="ui-button secondary"
      type="button"
      hidden
      data-copy="{id}-value"
      data-copied={t('admin.ui.copy.done')}
      data-failed={t('admin.ui.copy.failed')}>{t('admin.ui.copy')}</button
    >
  </div>
</section>
