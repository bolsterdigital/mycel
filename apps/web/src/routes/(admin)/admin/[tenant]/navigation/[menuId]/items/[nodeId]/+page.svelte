<!-- The form of one menu item. A link: where it leads (the target picker of the edit screen: a
     select of pages and articles, the home and search pages, or an address; with JavaScript one
     search field), for a page where on it the link lands (the parts of its published revision; a
     plain select that belongs to the saved page, so another page is saved first; a part that
     shows nothing on the site now says so) and an optional menu text of its own in the content
     locale, which when left empty follows the page's published title. A group: only its text.
     Native controls; the picker is an enhancement. After a conflict the fields hold what is saved
     now, and the notice repeats what this editor had typed, so a second Save is a choice made with
     both in view. -->
<script lang="ts">
  import TargetPicker from '#lib/admin/block-fields/TargetPicker.svelte';
  import { Field, FormPage, Notice, Select } from '#lib/admin/ui/index.js';
  import { fill, ui } from '../../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const tenant = $derived(`/admin/${data.tenant.slug}`);
  const back = $derived(`${tenant}/navigation/${data.menu.id}`);
  const title = $derived(
    t(
      data.nodeId
        ? data.kind === 'group'
          ? 'admin.navigation.editGroup'
          : 'admin.navigation.editLink'
        : data.kind === 'group'
          ? 'admin.navigation.addGroup'
          : 'admin.navigation.addLink'
    )
  );
  const value = (key: 'label' | 'target' | 'url' | 'anchor') =>
    form?.values?.[key] ?? data.values[key];
  // The anchor the link has, when the page no longer has that part: it stays a choice, so a save
  // of the text alone does not drop it, and the item says where the link now lands.
  const gone = $derived(
    !!data.values.anchor && !!data.anchors && !data.anchors.some((a) => a.id === data.values.anchor)
  );
  // The chosen part is there but shows nothing on the site now (a restricted image, a form that is
  // not there): the link lands at the top of the page, as it does for a part that is gone.
  const empty = $derived(
    !!data.values.anchor && !!data.anchors?.some((a) => a.id === data.values.anchor && !a.shown)
  );
  const anchorOptions = $derived([
    { value: '', label: t('admin.navigation.anchor.none') },
    ...(gone ? [{ value: data.values.anchor, label: t('admin.navigation.anchor.gone') }] : []),
    ...(data.anchors ?? []).map((a) => {
      const label = a.text
        ? fill(t('admin.navigation.anchor.option'), {
            type: t(`admin.block.type.${a.type}` as const),
            text: a.text,
          })
        : t(`admin.block.type.${a.type}` as const);
      return {
        value: a.id,
        label: a.shown ? label : fill(t('admin.navigation.anchor.empty'), { part: label }),
      };
    }),
  ]);
  // After a conflict the fields show what is saved now; what this editor typed stands in the notice.
  const yours = $derived(
    [form?.mine?.['label'], form?.mine?.['url']].filter((v) => v?.trim()).join(' · ')
  );
  const refused = $derived(
    form?.error === 'admin.navigation.error.address' ||
      form?.error === 'admin.navigation.error.targetRequired' ||
      form?.error === 'admin.navigation.error.targetGone'
  );
  const labelMissing = $derived(form?.error === 'admin.navigation.error.labelRequired');
  const textLabel = $derived(
    data.tenant.locales.length > 1
      ? fill(t('admin.navigation.field.label.in'), { locale: data.contentLocale })
      : t('admin.navigation.field.label')
  );
</script>

<svelte:head>
  <title>{title} · {data.menu.name} · {data.tenant.name}</title>
</svelte:head>

<FormPage
  {title}
  locale={data.locale}
  breadcrumb={[
    { label: data.tenant.name, href: tenant },
    { label: t('admin.navigation.title'), href: `${tenant}/navigation` },
    { label: data.menu.name, href: back },
    { label: title },
  ]}
  description={data.kind === 'group' ? t('admin.navigation.group.intro') : undefined}
  submit={t('admin.navigation.save')}
  cancel={{ href: back, label: data.menu.name }}
>
  {#snippet notices()}
    {#if form?.error}<Notice tone="error"
        >{t(form.error)}
        {#if yours}{fill(t('admin.navigation.error.yours'), { text: yours })}{/if}</Notice
      >{/if}
    {#if gone}<Notice tone="warning">{t('admin.navigation.problem.anchor-missing')}</Notice>{/if}
    {#if empty}<Notice tone="warning">{t('admin.navigation.problem.anchor-empty')}</Notice>{/if}
  {/snippet}
  <input type="hidden" name="baseRevisionId" value={data.baseRevisionId ?? ''} />
  <input type="hidden" name="kind" value={data.kind} />
  {#if data.kind === 'link'}
    <TargetPicker
      id="item-target"
      choices="{tenant}/content/choices?locale={encodeURIComponent(data.contentLocale)}"
      locale={data.locale}
      {refused}
    >
      <Select
        id="item-target"
        name="target"
        label={t('admin.block.field.target')}
        locale={data.locale}
        invalid={refused}
        value={value('target')}
        options={[
          { value: '', label: t('admin.block.none') },
          { value: 'home', label: t('admin.navigation.system.home') },
          { value: 'search', label: t('admin.navigation.system.search') },
          { value: 'url', label: t('admin.block.target.url') },
          ...data.items.map((i) => ({ value: i.id, label: i.label })),
        ]}
      />
      <Field
        id="item-url"
        name="url"
        label={t('admin.block.field.url')}
        hint={t('admin.navigation.field.url.hint')}
        hintInline
        locale={data.locale}
        invalid={refused}
        maxlength={2000}
        value={value('url')}
      />
    </TargetPicker>
    {#if data.anchors}
      <input type="hidden" name="anchorFor" value={data.anchorFor} />
      <Select
        id="item-anchor"
        name="anchor"
        label={t('admin.navigation.field.anchor')}
        hint={t('admin.navigation.field.anchor.hint')}
        locale={data.locale}
        value={value('anchor')}
        options={anchorOptions}
      />
    {:else if data.anchorFor}
      <p class="ui-hint">
        {fill(t('admin.navigation.anchor.unpublished'), { locale: data.contentLocale })}
      </p>
    {:else if !data.nodeId}
      <p class="ui-hint">{t('admin.navigation.anchor.later')}</p>
    {/if}
  {/if}
  <Field
    id="item-label"
    name="label"
    label={textLabel}
    hint={data.kind === 'group'
      ? t('admin.navigation.field.label.groupHint')
      : data.inherited
        ? fill(
            t(
              data.restricted
                ? 'admin.navigation.field.label.inheritsRestricted'
                : 'admin.navigation.field.label.inherits'
            ),
            { title: data.inherited }
          )
        : t('admin.navigation.field.label.hint')}
    hintInline
    locale={data.locale}
    required={data.kind === 'group'}
    invalid={labelMissing}
    maxlength={120}
    value={value('label')}
  />
</FormPage>
