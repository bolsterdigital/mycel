<!-- The selection and all three optional frames are native form fields. The two scaled previews
     share the public positioning rules and follow the stored form values on a server render. -->
<script lang="ts">
  import { ImageFraming, type ImagePlacement } from '@mycel/core';
  import { ui } from '../../../i18n/index.js';
  import { framingAttributes } from '../../blocks/framing.js';
  import type { MediaChoice } from '../media-choice.js';
  import { framingFrom } from './placement-fields.js';
  import { Checkbox, Choices, Field } from '#lib/admin/ui/index.js';

  let {
    name,
    picker,
    media,
    base,
    locale,
    layout,
    read,
    fallback = '',
  }: {
    name: string;
    picker: string;
    media: MediaChoice;
    base: string;
    locale: string;
    layout: 'person' | 'overview' | 'cover' | 'split' | 'standard';
    read: (key: string) => string;
    fallback?: string;
  } = $props();

  const t = $derived(ui(locale));
  const matching = $derived(read(`${name}.mediaId`) === media.id);
  const stored = (key: string) => (matching ? read(key) : '');
  const framing = (slot: string) => {
    const result = ImageFraming.safeParse(framingFrom(stored, `${name}.${slot}`));
    return result.success ? result.data : undefined;
  };
  const placement: ImagePlacement = $derived({
    mediaId: media.id,
    framing: framing('framing'),
    narrow: framing('narrow'),
    wide: framing('wide'),
  });
  const focal = $derived(media.focal ?? { x: 0.5, y: 0.5 });
  const reset = $derived(stored(`${name}.reset`) === 'on');
  const attributes = $derived(framingAttributes(reset ? undefined : placement, focal));
  const source = $derived(
    focal.mode === 'auto' ? t('admin.placement.sourceAuto') : t('admin.placement.sourceMedia')
  );
  const src = $derived(media.card ? `${base}/media/${media.id}/variant/${media.card.file}` : '');
</script>

{#snippet controls(slot: 'framing' | 'narrow' | 'wide', label: string)}
  {@const key = `${name}.${slot}`}
  {@const mode = stored(`${key}.mode`) || 'inherit'}
  <div class="placement-controls" data-placement-slot={slot}>
    <Choices
      id="{key}-mode"
      name="{key}.mode"
      legend={label}
      {locale}
      selected={[mode]}
      options={(['inherit', 'auto', 'manual', 'full'] as const).map((value) => ({
        value,
        label: t(
          value === 'inherit' && slot !== 'framing'
            ? 'admin.placement.same'
            : `admin.placement.${value}`
        ),
      }))}
    />
    <div class="placement-position">
      {#each ['x', 'y'] as const as axis (axis)}
        <Field
          id="{key}.{axis}"
          name="{key}.{axis}"
          type="number"
          label={t(`admin.placement.${axis}`)}
          {locale}
          min="0"
          max="100"
          step="any"
          inputmode="decimal"
          value={stored(`${key}.${axis}`) || '50'}
        />
      {/each}
    </div>
  </div>
{/snippet}

<details
  class="image-placement"
  data-image-placement
  data-picker={picker}
  data-layout={layout}
  data-fallback={fallback}
  data-focal={focal.mode}
>
  <summary>{t('admin.placement.label')}</summary>
  <p class="ui-hint" data-placement-source>{source}</p>
  <p class="ui-hint" data-placement-replaced hidden>{t('admin.placement.replaced')}</p>
  <div data-placement-fields>
    <input type="hidden" name="{name}.shown" value="on" />
    <input type="hidden" name="{name}.mediaId" value={media.id} data-placement-media />
    <div class="placement-previews">
      {#each ['narrow', 'wide'] as const as size (size)}
        <figure data-frame-preview={size}>
          <figcaption>{t(`admin.placement.${size}`)}</figcaption>
          {#if media.card}
            <img
              {src}
              alt=""
              width={media.card.width}
              height={media.card.height}
              loading="lazy"
              class="fx-{Math.round(focal.x * 10)} fy-{Math.round(focal.y * 10)}"
              data-frame-fit={attributes['data-frame-fit']}
              data-frame-x={attributes['data-frame-x']}
              data-frame-y={attributes['data-frame-y']}
              data-frame-fit-narrow={attributes['data-frame-fit-narrow']}
              data-frame-x-narrow={attributes['data-frame-x-narrow']}
              data-frame-y-narrow={attributes['data-frame-y-narrow']}
              data-frame-fit-wide={attributes['data-frame-fit-wide']}
              data-frame-x-wide={attributes['data-frame-x-wide']}
              data-frame-y-wide={attributes['data-frame-y-wide']}
              draggable="false"
            />
          {/if}
        </figure>
      {/each}
    </div>
    <p class="ui-hint">{t('admin.placement.hint')}</p>
    {@render controls('framing', t('admin.placement.general'))}
    <details class="placement-exceptions" open={Boolean(placement.narrow || placement.wide)}>
      <summary>{t('admin.placement.exceptions')}</summary>
      {@render controls('narrow', t('admin.placement.narrow'))}
      {@render controls('wide', t('admin.placement.wide'))}
    </details>
    <div data-placement-reset>
      <Checkbox
        id="{name}-reset"
        name="{name}.reset"
        label={t('admin.placement.reset')}
        checked={reset}
      />
    </div>
  </div>
</details>

<style>
  .image-placement {
    min-width: 0;
    margin-block: 0.75rem;
  }
  summary {
    cursor: pointer;
    min-height: 44px;
    align-content: center;
  }
  .placement-previews,
  .placement-position {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
  }
  figure {
    margin: 0;
    min-width: 0;
  }
  img {
    display: block;
    width: 100%;
    height: auto;
    object-fit: var(--frame-fit, cover);
    background: var(--color-surface-bg);
  }
  .image-placement:not([data-layout='standard']) img {
    aspect-ratio: 3 / 2;
  }
  .image-placement[data-layout='person'] [data-frame-preview='narrow'] img {
    aspect-ratio: 286 / 200;
  }
  .image-placement[data-layout='person'] [data-frame-preview='wide'] img {
    aspect-ratio: 255 / 200;
  }
  .image-placement[data-layout='cover'] [data-frame-preview='narrow'] img {
    aspect-ratio: 390 / 830;
    width: 48%;
    margin-inline: auto;
  }
  .image-placement[data-layout='cover'] [data-frame-preview='wide'] img {
    aspect-ratio: 1440 / 830;
  }
  .image-placement[data-layout='split'] img {
    aspect-ratio: 4 / 3;
  }
  .placement-controls:not(:has(:global(input[type='radio'][value='manual']:checked)))
    .placement-position {
    display: none;
  }
  .placement-position {
    margin-block-start: 0.5rem;
  }
  .image-placement:global([data-drag-ready]) img {
    touch-action: pan-y;
  }
  .image-placement:global([data-drag-ready]) img:global([data-draggable]) {
    touch-action: none;
    cursor: grab;
  }
</style>
