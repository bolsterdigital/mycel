<!-- The placements form: one select per place, the bar items of the placed main menu as
     checkboxes, and four numbered footer slots with a title each in the content locale. Native
     controls, one submit. The same menu may be chosen for several places; nothing here overrides
     a menu's texts or order (ADR 036 rule 4). -->
<script lang="ts">
  import { Checkbox, Field, Fieldset, FormPage, Notice, Select } from '#lib/admin/ui/index.js';
  import { fill, ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/navigation`);
  const title = $derived(t('admin.navigation.placements'));
  const options = $derived([
    { value: '', label: t('admin.navigation.placements.none') },
    ...data.menus,
  ]);
  const value = (key: string, saved: string) => form?.values?.[key] ?? saved;
  const ticked = (id: string) =>
    form?.values ? `bar:${id}` in form.values : (data.form.bar ?? []).includes(id);
</script>

<svelte:head>
  <title>{title} · {t('admin.navigation.title')} · {data.tenant.name}</title>
</svelte:head>

<FormPage
  {title}
  locale={data.locale}
  breadcrumb={[
    { label: data.tenant.name, href: `/admin/${data.tenant.slug}` },
    { label: t('admin.navigation.title'), href: base },
    { label: title },
  ]}
  description={t('admin.navigation.placements.intro')}
  submit={t('admin.navigation.placements.submit')}
  cancel={{ href: base, label: t('admin.navigation.title') }}
>
  {#snippet notices()}
    {#if form?.error}<Notice tone="error">{t(form.error)}</Notice>{/if}
    {#if !data.menus.length}<Notice tone="info" live={false}
        >{t('admin.navigation.placements.noMenus')}</Notice
      >{/if}
  {/snippet}
  <input type="hidden" name="baseRevisionId" value={data.baseRevisionId ?? ''} />
  <Fieldset legend={t('admin.navigation.placement.main')}>
    <Select
      id="placement-main"
      name="main"
      label={t('admin.navigation.column.name')}
      hint={t('admin.navigation.placements.main.hint')}
      locale={data.locale}
      {options}
      value={value('main', data.form.main)}
    />
    {#if data.bar}
      <input type="hidden" name="barShown" value="1" />
      <Fieldset
        legend={t('admin.navigation.placements.bar')}
        hint={fill(t('admin.navigation.placements.bar.hint'), { menu: data.bar.menu })}
      >
        {#each data.bar.items as item (item.id)}
          <Checkbox
            id="bar-{item.id}"
            name="bar:{item.id}"
            label={item.label ??
              (item.system
                ? t(`admin.navigation.system.${item.system}`)
                : t('admin.navigation.noLabel'))}
            checked={ticked(item.id)}
          />
        {:else}
          <p>{t('admin.navigation.placements.bar.empty')}</p>
        {/each}
      </Fieldset>
    {/if}
  </Fieldset>
  <Fieldset legend={t('admin.navigation.placement.actions')}>
    <Select
      id="placement-actions"
      name="actions"
      label={t('admin.navigation.column.name')}
      hint={t('admin.navigation.placements.actions.hint')}
      locale={data.locale}
      {options}
      value={value('actions', data.form.actions)}
    />
  </Fieldset>
  <Fieldset
    legend={t('admin.navigation.placement.footer')}
    hint={t('admin.navigation.placements.footer.hint')}
  >
    {#each data.form.footer as slot, i (i)}
      <Fieldset legend={fill(t('admin.navigation.placements.column'), { n: i + 1 })}>
        <Select
          id="placement-footer-{i}"
          name="footer{i}"
          label={fill(t('admin.navigation.placements.column.menu'), { n: i + 1 })}
          locale={data.locale}
          {options}
          value={value(`footer${i}`, slot.menuId)}
        />
        <Field
          id="placement-footer-{i}-title"
          name="footer{i}Title"
          label={fill(t('admin.navigation.placements.column.title'), {
            n: i + 1,
            locale: data.contentLocale,
          })}
          hint={t('admin.navigation.placements.column.title.hint')}
          hintInline
          maxlength={240}
          locale={data.locale}
          value={value(`footer${i}Title`, slot.title)}
        />
      </Fieldset>
    {/each}
  </Fieldset>
  <Fieldset legend={t('admin.navigation.placement.legal')}>
    <Select
      id="placement-legal"
      name="legal"
      label={t('admin.navigation.column.name')}
      hint={t('admin.navigation.placements.legal.hint')}
      locale={data.locale}
      {options}
      value={value('legal', data.form.legal)}
    />
  </Fieldset>
</FormPage>
