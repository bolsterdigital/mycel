<!-- What a new item starts from, one native select for `content/new` and the empty column of
     an item: the standard long read (and, in `content/new`, the photo story) under "Standard" for
     an article, then the site's own patterns per type. `optional` adds "no pattern" first, for a form that also makes the item. The server
     side, values and blocks: `lib/server/patterns/choice.ts`. Rejected: a radio list, which grows
     with every pattern a site saves. -->
<script lang="ts" module>
  import type { PatternChoices } from '#lib/server/patterns/choice.js';

  /** Whether `choices` offers anything to choose. */
  export const offers = (choices: PatternChoices | null): choices is PatternChoices =>
    !!choices && (!!choices.longRead || !!choices.photoStory || choices.own.length > 0);
</script>

<script lang="ts">
  import { Field } from '#lib/admin/ui/index.js';
  import { ui } from '../../../i18n/index.js';

  let {
    id,
    locale,
    choices,
    selected = '',
    optional = false,
  }: {
    id: string;
    locale: string;
    choices: PatternChoices;
    selected?: string;
    optional?: boolean;
  } = $props();
  const t = $derived(ui(locale));
</script>

<Field {id} label={t('admin.content.new.pattern')} {locale}>
  {#snippet control(attributes)}
    <select name="patternId" {...attributes}>
      {#if optional}<option value="">{t('admin.content.new.noPattern')}</option>{/if}
      {#if choices.longRead || choices.photoStory}
        <optgroup label={t('admin.content.new.standard')}>
          {#if choices.longRead}
            <option value={choices.longRead} selected={selected === choices.longRead}
              >{t('admin.content.new.longRead')}</option
            >
          {/if}
          {#if choices.photoStory}
            <option value={choices.photoStory} selected={selected === choices.photoStory}
              >{t('admin.content.new.photoStory')}</option
            >
          {/if}
        </optgroup>
      {/if}
      {#each ['page', 'article'] as const as group (group)}
        {#if choices.own.some((p) => p.type === group)}
          <optgroup label={t(`admin.content.type.${group}`)}>
            {#each choices.own.filter((p) => p.type === group) as p (p.id)}
              <option value={p.id} selected={selected === p.id}>{p.name}</option>
            {/each}
          </optgroup>
        {/if}
      {/each}
    </select>
  {/snippet}
</Field>
