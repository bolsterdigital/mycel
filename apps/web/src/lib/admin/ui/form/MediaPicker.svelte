<!-- One image choice, the same everywhere an image is picked (brief media-picker, TODO #66): the
     current choice as a thumbnail with its name, and a dialog with the site's images as a grid of
     radio buttons inside the surrounding form. Without JavaScript the dialog opens through native
     invokers and a choice is an ordinary form value; static/_admin/media-picker.js adds search,
     dropping files to upload with progress, and the live thumbnail. The preview's nodes always
     exist (no {#if}) so the script and a hydrated page set the same attributes instead of
     fighting over a subtree. Rejected: a <select> of filenames (editor trial 2026-10-28) and a separate picker
     page, which loses what was typed in the form. -->
<script lang="ts">
  import AdminScript from '../../trusted/AdminScript.svelte';
  import { ui } from '../../../../i18n/index.js';
  import type { MediaChoice } from '../../media-choice.js';
  import { THUMB, thumbPath } from '../../thumb.js';
  import Actions from '../display/Actions.svelte';
  import Dialog from '../feedback/Dialog.svelte';
  import HintButton from '../feedback/HintButton.svelte';

  let {
    id,
    name,
    label,
    locale,
    value,
    options,
    base,
    hint,
    invalid = false,
    upload = false,
    onchange,
  }: {
    id: string;
    name: string;
    label: string;
    locale: string;
    /** The chosen media id, '' for none. */
    value: string;
    options: readonly MediaChoice[];
    /** The tenant's admin root, `/admin/<slug>`: thumbnails, search and upload live under it. */
    base: string;
    hint?: string | undefined;
    invalid?: boolean;
    /** Offer uploading in the dialog (the operator has `media:write`). */
    upload?: boolean;
    /** For a hydrated page: the id chosen, also one the script added by searching or uploading. */
    onchange?: ((id: string) => void) | undefined;
  } = $props();

  const t = $derived(ui(locale));
  const thumb = (o: MediaChoice) => (o.thumb ? thumbPath(base, o.id) : '');
  // A choice the script added (a search result or an upload) is not in `options`; remember it
  // so a hydrated page still shows its name.
  let added = $state<MediaChoice | null>(null);
  const chosen = $derived(
    options.find((o) => o.id === value) ?? (added?.id === value ? added : null)
  );
  const copy = $derived(
    JSON.stringify({
      search: t('admin.media.picker.search'),
      drop: t('admin.media.picker.drop'),
      more: t('admin.media.picker.more'),
      nothing: t('admin.media.picker.nothing'),
      uploading: t('admin.media.picker.uploading'),
      uploaded: t('admin.media.picker.uploaded'),
      failed: t('admin.media.picker.failed'),
      searchFailed: t('admin.media.picker.searchFailed'),
      none: t('admin.media.picker.none'),
      choose: t('admin.media.picker.choose'),
      change: t('admin.media.picker.change'),
    })
  );

  function changed(event: Event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== name || !input.checked) return;
    if (input.value && !options.some((o) => o.id === input.value))
      added = {
        id: input.value,
        label: input.dataset.label ?? input.value,
        thumb: !!input.dataset.thumb,
      };
    onchange?.(input.value);
  }
</script>

{#snippet option(o: MediaChoice)}
  <li>
    <label class="ui-media-option">
      <input
        type="radio"
        {name}
        value={o.id}
        checked={value === o.id}
        data-label={o.label}
        data-thumb={thumb(o)}
      />
      {#if o.thumb}
        <img
          src={thumb(o)}
          alt=""
          width={THUMB.choice.width}
          height={THUMB.choice.height}
          loading="lazy"
        />
      {:else}
        <span class="ui-media-option-blank"></span>
      {/if}
      <span class="ui-media-option-name">{o.label}</span>
    </label>
  </li>
{/snippet}

<fieldset
  {id}
  class={['ui-media-picker', invalid && 'invalid']}
  aria-labelledby={hint ? `${id}-legend` : undefined}
  aria-describedby={hint ? `${id}-hint` : undefined}
  data-media-picker
  data-name={name}
  data-choices="{base}/media/choices"
  data-upload={upload ? `${base}/media/upload` : undefined}
  data-copy={copy}
  onchange={changed}
>
  <legend
    ><span id="{id}-legend">{label}</span>{#if hint}<HintButton
        target="{id}-hint"
        labelId="{id}-legend"
        {locale}
      />{/if}</legend
  >
  {#if hint}<p class="ui-hint" id="{id}-hint" popover>{hint}</p>{/if}
  <div class="ui-media-picker-current">
    <img
      data-picker-img
      src={chosen?.thumb ? thumb(chosen) : undefined}
      hidden={!chosen?.thumb}
      alt=""
      width={THUMB.choice.width}
      height={THUMB.choice.height}
    />
    <span data-picker-name class={[!chosen && value === '' && 'muted']}
      >{chosen?.label ?? (value || t('admin.media.picker.none'))}</span
    >
  </div>
  <Dialog
    id="{id}-dialog"
    title={label}
    trigger={value ? t('admin.media.picker.change') : t('admin.media.picker.choose')}
    {locale}
    wide
  >
    <div class="ui-media-picker-tools" data-picker-tools></div>
    <p class="ui-hint" data-picker-noscript>
      <a href="{base}/media" target="_blank">{t('admin.media.picker.uploadLink')}</a>
    </p>
    <ul class="ui-media-grid" aria-label={t('admin.media.picker.library')} data-picker-initial>
      <li>
        <label class="ui-media-option">
          <input type="radio" {name} value="" checked={value === ''} data-label="" data-thumb="" />
          <span class="ui-media-option-blank"></span>
          <span class="ui-media-option-name">{t('admin.media.picker.noImage')}</span>
        </label>
      </li>
      {#if value && !options.some((o) => o.id === value)}
        {@render option(chosen ?? { id: value, label: value, thumb: false })}
      {/if}
      {#each options as o (o.id)}
        {@render option(o)}
      {/each}
    </ul>
    <ul
      class="ui-media-grid"
      aria-label={t('admin.media.picker.library')}
      data-picker-results
      hidden
    ></ul>
    <Actions end>
      <button class="ui-button" type="button" commandfor="{id}-dialog" command="close"
        >{t('admin.media.picker.done')}</button
      >
    </Actions>
  </Dialog>
  <AdminScript src="/_admin/media-picker.js" />
</fieldset>
