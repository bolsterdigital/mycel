<!-- The header image's alt and crop travel with the draft form, beside its existing picker. -->
<script lang="ts">
  import { MediaPicker } from '#lib/admin/ui/index.js';
  import type { MediaChoice } from '../media-choice.js';
  import HeroAltRow from '../hero-alt/HeroAltRow.svelte';
  import { ui } from '../../../i18n/index.js';
  import ImagePlacementFields from './ImagePlacementFields.svelte';

  let {
    base,
    locale,
    work,
    docLocales,
    v,
    saved,
    media,
    upload,
    heroAltRefused,
  }: {
    base: string;
    locale: string;
    work: string;
    docLocales: string[];
    v: (key: string) => string;
    saved: (key: string) => string;
    media: MediaChoice[];
    upload: boolean;
    heroAltRefused: boolean;
  } = $props();
  const t = $derived(ui(locale));
  const photo = $derived(media.find((m) => m.id === v('heroImageId')));
  const profile = $derived(v('articleProfile'));
  const profileHeader = $derived(
    v(`profile.${profile}.header`) || (profile === 'longread' ? 'cover' : 'standard')
  );
  const layout = $derived(
    profile
      ? profileHeader === 'cover'
        ? 'cover'
        : 'compact'
      : v('headerLayout') === 'cover'
        ? 'cover'
        : v('headerLayout') === 'split'
          ? 'split'
          : 'standard'
  );
</script>

<div class="header-image-fields">
  <MediaPicker
    id="heroImageId"
    name="heroImageId"
    label={t('admin.content.field.heroImage')}
    hint={t('admin.content.field.heroImageHint')}
    {locale}
    value={v('heroImageId')}
    options={media}
    {base}
    {upload}
  >
    {#snippet related()}
      <HeroAltRow
        {locale}
        {work}
        locales={docLocales}
        image={v('heroImageId')}
        savedImage={saved('heroImageId')}
        text={v(`heroAlt.${work}`)}
        savedText={saved(`heroAlt.${work}`)}
        others={Object.fromEntries(
          docLocales.filter((l) => l !== work).map((l) => [l, saved(`heroAlt.${l}`)])
        )}
        clearing={v('heroDecorative') === 'on'}
        flagged={heroAltRefused}
      />
    {/snippet}
  </MediaPicker>

  {#if photo}
    <ImagePlacementFields
      name="heroPlacement"
      picker="heroImageId"
      media={photo}
      {base}
      {locale}
      {layout}
      read={v}
    />
  {/if}
</div>

<style>
  /* The hero and its description are one group; the shared picker stays frameless. */
  .header-image-fields :global(#heroImageId) {
    gap: 0;
    padding: 0;
    border: var(--border-width) solid var(--color-border-strong);
    border-radius: var(--radius);
  }
  .header-image-fields :global(#heroImageId > legend) {
    margin-inline-start: var(--space-1);
    padding-inline: var(--space-0);
    margin-block-end: 0;
  }
  .header-image-fields :global(#heroImageId .ui-media-picker-selection) {
    padding: var(--space-1) var(--space-2);
  }
  .header-image-fields :global(#heroImageId .ui-media-picker-related) {
    display: block;
  }
</style>
