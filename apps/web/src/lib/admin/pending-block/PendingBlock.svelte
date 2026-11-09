<!-- The block chosen but not stored yet (`lib/server/content/edit-form.ts`): its fields at its place,
     its type and place as hidden fields, and the two ways out, adding it with the save or not.
     One that came from dropped or pasted images is marked, so the screen's script puts the
     focus on the alt text and asks before leaving. Its own component since the edit screen shows
     it at three places. Rejected: the snippet in the screen, which held its file at its ceiling. -->
<script lang="ts">
  import { BLOCK_DEFINITIONS, type BlockType } from '@mycel/core';
  import BlockFields from '../block-fields/BlockFields.svelte';
  import { BLOCK_PRESENTATION } from '../block-presentation.js';
  import { Actions, Button } from '../ui/index.js';
  import type { MediaChoice } from '../media-choice.js';
  import { fill, ui } from '../../../i18n/index.js';

  let {
    pending,
    values,
    locales,
    media,
    base,
    upload,
    references,
    items = [],
    people = [],
    personGroups = [],
    invalid,
    locale,
    action,
  }: {
    pending: {
      type: string;
      hidden: Record<string, string>;
      values: Record<string, string>;
      dropped: boolean;
    };
    /** What a restored session typed, on top of the pending block's own values. */
    values: Record<string, string>;
    locales: readonly string[];
    media: readonly MediaChoice[];
    base: string;
    upload: boolean;
    items?: readonly { id: string; label: string }[];
    references?: {
      items: readonly { id: string; label: string }[];
      people: readonly { id: string; label: string }[];
      personGroups: readonly { id: string; label: string }[];
    };
    people?: readonly { id: string; label: string }[];
    personGroups?: readonly { id: string; label: string }[];
    invalid: readonly string[];
    locale: string;
    /** The form action of a named button, in the locale the screen shows. */
    action: (name: string) => string;
  } = $props();
  const t = $derived(ui(locale));
  const type = $derived(pending.type as BlockType);
</script>

<section
  id="block-new"
  class="ui-panel pending"
  aria-labelledby="block-new-title"
  data-dropped={pending.dropped ? '' : undefined}
>
  <h3 id="block-new-title">
    {fill(t('admin.block.new'), { type: t(`admin.block.type.${type}` as const) })}
  </h3>
  {#each Object.entries(pending.hidden) as [name, value] (name)}
    <input type="hidden" {name} {value} />
  {/each}
  <BlockFields
    fields={BLOCK_DEFINITIONS[type].fields}
    imageDescription={type === 'image' ? { image: '', alt: null, locales } : undefined}
    values={{ ...pending.values, ...values }}
    {locales}
    idPrefix="b-new"
    prefix="new."
    {media}
    {base}
    {upload}
    {references}
    {items}
    {people}
    {personGroups}
    {invalid}
    {locale}
    row={BLOCK_PRESENTATION[type].row}
  />
  <Actions>
    <Button formaction={action('save')}>{t('admin.block.new.add')}</Button>
    <Button variant="secondary" formaction={action('discard')} formnovalidate
      >{t('admin.block.new.discard')}</Button
    >
  </Actions>
</section>
