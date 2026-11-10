<!-- Localised plain text stays separate from executable templates; blank overrides inherit. -->
<script lang="ts">
  import { Field } from '../ui/index.js';
  import { ui } from '../../../i18n/index.js';
  let {
    prefix,
    id,
    label,
    locale,
    value = {},
    multiline = false,
  }: {
    prefix: string;
    id: string;
    label: string;
    locale: string;
    value?: Record<string, string>;
    multiline?: boolean;
  } = $props();
</script>

{#each ['nl', 'en'] as lang}
  <Field
    id="{id}-{lang}"
    label={`${label} (${lang})`}
    {locale}
    name="{prefix}.{lang}"
    value={value[lang] ?? ''}
  >
    {#snippet control(attrs)}
      {#if multiline}<textarea {...attrs} name="{prefix}.{lang}" rows="4"
          >{value[lang] ?? ''}</textarea
        >{:else}<input {...attrs} name="{prefix}.{lang}" value={value[lang] ?? ''} />{/if}
    {/snippet}
  </Field>
{/each}
