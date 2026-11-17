<!--
  Who may read an item and what everyone else sees (ADR 016): the level, the tiers the level
  `tier` asks for, and the teaser. All fields are in the form at once, so it works without
  JavaScript; the tier boxes count only with the level `tier`, which the hint says.
  Rejected: showing the boxes only after choosing `tier` (needs a script or a second request).
-->
<script lang="ts">
  import { Choices, Field, Fieldset, Select } from '#lib/admin/ui/index.js';
  import { ui } from '../../../i18n/index.js';

  let {
    locale,
    level,
    teaser,
    teaserBlocks,
    tierIds,
    tiers,
    flagged,
    collapsed,
    manage,
  }: {
    locale: string;
    level: string;
    teaser: string;
    teaserBlocks: string;
    tierIds: readonly string[];
    tiers: readonly { id: string; name: string }[];
    flagged: (field: string) => boolean;
    collapsed: boolean;
    /** Where the tiers are managed, for who may change them. */
    manage?: string | undefined;
  } = $props();

  const t = $derived(ui(locale));
  // The level `tier` is offered once a tier exists, and stays on an item that has it.
  const levels = $derived(
    (['public', 'members', 'tier'] as const).filter(
      (value) => value !== 'tier' || tiers.length > 0 || level === 'tier'
    )
  );
  const TEASERS = ['lead', 'marker', 'blocks'] as const;
</script>

<Fieldset legend={t('admin.content.edit.access')} {collapsed}>
  <Select
    id="level"
    name="level"
    invalid={flagged('level')}
    label={t('admin.content.field.level')}
    {locale}
    value={level}
    options={levels.map((value) => ({
      value,
      label: t(`admin.content.level.${value}`),
    }))}
  />
  {#if tiers.length}
    <input type="hidden" name="tiersShown" value="1" />
    <Choices
      id="tierIds"
      name="tierIds"
      type="checkbox"
      legend={t('admin.content.field.tiers')}
      hint={t('admin.content.field.tiers.hint')}
      {locale}
      options={tiers.map((tier) => ({ value: tier.id, label: tier.name }))}
      selected={tierIds}
    />
  {/if}
  {#if manage}
    <p><a href={manage}>{t('admin.content.tiers.manage')}</a></p>
  {/if}
  <Select
    id="teaser"
    name="teaser"
    invalid={flagged('teaser')}
    label={t('admin.content.field.teaser')}
    {locale}
    value={teaser}
    options={TEASERS.map((value) => ({
      value,
      label: t(`admin.content.teaser.${value}`),
    }))}
  />
  <Field
    id="teaserBlocks"
    name="teaserBlocks"
    invalid={flagged('teaserBlocks')}
    type="number"
    label={t('admin.content.field.teaserBlocks')}
    {locale}
    min="0"
    max="200"
    value={teaserBlocks}
  />
</Fieldset>
