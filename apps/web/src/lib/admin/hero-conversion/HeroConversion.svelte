<!-- A legacy hero's way into the header (ADR 025 rule 5): what would move and what stands in the
     way, both from the same proposal the command applies. One deliberate button, no dialog: it
     writes a new draft, and what is live stays. The block itself stays fully editable below. -->
<script lang="ts">
  import type { HeroConversion } from '@mycel/core';
  import { pick } from '@mycel/core';
  import { Button, Notice } from '#lib/admin/ui/index.js';
  import { fill, ui } from '../../../i18n/index.js';

  let {
    c,
    locale,
    work,
    defaultLocale,
    formaction,
  }: {
    c: HeroConversion;
    /** The admin's language. */
    locale: string;
    /** The content locale the form shows. */
    work: string;
    defaultLocale: string;
    formaction: string;
  } = $props();
  const t = $derived(ui(locale));
  type Row = HeroConversion['fields'][number];
  const label = (field: Row['field'], of: string | null) =>
    t(`admin.content.heroConversion.field.${field}` as const) + (of ? ` (${of})` : '');
  const shown = (row: Row) =>
    `${label(row.field, row.locale)}: ${
      row.field === 'image' ? t('admin.content.heroConversion.imageValue') : row.hero
    }`;
</script>

<Notice tone="warning" live={false} title={t('admin.content.heroConversion.title')}>
  {#if c.conflicts.length}
    <p>{t('admin.content.heroConversion.blocked')}</p>
    <ul>
      {#each c.conflicts as conflict (conflict.code + conflict.locale)}
        {@const row = c.fields.find(
          (f) => f.field === conflict.code && f.locale === conflict.locale
        )}
        <li>
          {t(`admin.content.heroConversion.conflict.${conflict.code}` as const)}
          {#if conflict.locale}({conflict.locale}){/if}
          {#if row && row.field !== 'image'}
            {fill(t('admin.content.heroConversion.differs'), {
              value: row.hero,
              header: row.header ?? '',
            })}
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p>{t('admin.content.heroConversion.ready')}</p>
    <ul>
      {#each c.fields as row (row.field + row.locale)}
        <li>
          {fill(
            t(
              row.header === null
                ? 'admin.content.heroConversion.moves'
                : 'admin.content.heroConversion.same'
            ),
            { value: shown(row) }
          )}
        </li>
      {/each}
      {#if c.cta}
        <li>
          {fill(t('admin.content.heroConversion.cta'), {
            labels: c.cta.actions.map((a) => pick(a.label, work, defaultLocale) ?? '').join(', '),
          })}
        </li>
      {/if}
      {#if c.teaser}
        <li>{fill(t('admin.content.heroConversion.teaser'), c.teaser)}</li>
      {/if}
      {#if c.layout.variant !== 'minimal'}
        <li>{fill(t('admin.content.heroConversion.layout'), { variant: c.layout.variant })}</li>
      {/if}
    </ul>
    <Button variant="secondary" {formaction} name="convertHero" value={c.heroId}
      >{t('admin.content.heroConversion.action')}</Button
    >
  {/if}
</Notice>
