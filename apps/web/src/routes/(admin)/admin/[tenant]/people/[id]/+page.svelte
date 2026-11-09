<!-- Content first, optional contact and page settings folded. Other content locales survive a save. -->
<script lang="ts">
  import { page } from '$app/state';
  import { FormPage, Field, Fieldset, Select, MediaPicker, Notice } from '#lib/admin/ui/index.js';
  import { ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const value = (key: string, initial = '') => form?.values?.[key] ?? initial;
  const person = $derived(data.person);
  const contactFields = ['publicEmail', 'phone', 'email'] as const;
  const kinds = [
    'website',
    'linkedin',
    'bluesky',
    'mastodon',
    'instagram',
    'x',
    'facebook',
    'tiktok',
    'youtube',
    'other',
  ] as const;
  const links = $derived.by(() => {
    const rest = [...(person?.links ?? [])];
    const fixed = (kind: 'website' | 'linkedin') => {
      const i = rest.findIndex((l) => l.kind === kind);
      return i < 0
        ? { kind, label: t(`admin.people.kind.${kind}`), url: '' }
        : rest.splice(i, 1)[0]!;
    };
    return [fixed('website'), fixed('linkedin'), ...rest];
  });
</script>

<svelte:head
  ><title>{t(person ? 'admin.people.edit' : 'admin.people.new')} · {data.tenant.name}</title
  ></svelte:head
>
<FormPage
  title={person?.name ?? t('admin.people.new')}
  locale={data.locale}
  submit={t('admin.people.save')}
  cancel={{ href: `${base}/people`, label: t('admin.people.cancel') }}
>
  {#snippet notices()}
    {#if form?.error}<Notice tone="error">{t(form.error)}</Notice
      >{:else if page.url.searchParams.has('saved')}<Notice tone="success"
        >{t('admin.people.saved')}</Notice
      >{/if}
  {/snippet}
  <input type="hidden" name="contentLocale" value={value('contentLocale', data.contentLocale)} />
  <input
    type="hidden"
    name="baseUpdatedAt"
    value={value('baseUpdatedAt', person?.updatedAt ?? '')}
  />
  <Field
    id="person-name"
    name="name"
    required
    maxlength={200}
    label={t('admin.people.name')}
    locale={data.locale}
    value={value('name', person?.name)}
  />
  {#if data.media}<MediaPicker
      id="person-image"
      name="imageId"
      label={t('admin.people.image')}
      locale={data.locale}
      {base}
      options={data.media}
      upload={data.upload}
      value={value('imageId', person?.imageId)}
    />
  {:else}<input type="hidden" name="imageId" value={value('imageId', person?.imageId)} />{/if}
  <Field
    id="person-role"
    name="role"
    maxlength={200}
    label={t('admin.people.role')}
    locale={data.locale}
    value={value('role', person?.role?.[data.contentLocale])}
  />
  <Field
    id="person-organisation"
    name="organisation"
    maxlength={200}
    label={t('admin.people.organisation')}
    locale={data.locale}
    value={value('organisation', person?.organisation)}
  />
  <Field id="person-bio" label={t('admin.people.bio')} locale={data.locale}>
    {#snippet control(attributes)}<textarea {...attributes} name="bio" rows="6" maxlength="5000"
        >{value('bio', person?.bio?.[data.contentLocale])}</textarea
      >{/snippet}
  </Field>
  <Fieldset legend={t('admin.people.contact')} collapsed={!form?.error}>
    {#each contactFields as key}
      <Field
        id="person-{key}"
        name={key}
        type={key === 'phone' ? 'tel' : 'email'}
        label={t(`admin.people.${key}`)}
        locale={data.locale}
        hint={key === 'email' ? t('admin.people.emailHint') : undefined}
        value={value(key, person?.[key as 'email' | 'phone' | 'publicEmail'])}
      />
    {/each}
  </Fieldset>
  <Fieldset legend={t('admin.people.links')} collapsed={!form?.error}>
    {#each [0, 1] as i}
      <input type="hidden" name="link.{i}.kind" value={value(`link.${i}.kind`, links[i]?.kind)} />
      <input
        type="hidden"
        name="link.{i}.label"
        value={value(`link.${i}.label`, links[i]?.label)}
      />
      <Field
        id="link-{i}"
        name="link.{i}.url"
        type="url"
        label={t(i === 0 ? 'admin.people.kind.website' : 'admin.people.kind.linkedin')}
        locale={data.locale}
        value={value(`link.${i}.url`, links[i]?.url)}
      />
    {/each}
    {#each [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as i}
      <details class="ui-fold" open={!!value(`link.${i}.url`, links[i]?.url)}>
        <summary>{value(`link.${i}.label`, links[i]?.label) || t('admin.people.moreLinks')}</summary
        >
        <Select
          id="link-kind-{i}"
          name="link.{i}.kind"
          label={t('admin.people.linkKind')}
          locale={data.locale}
          value={value(`link.${i}.kind`, links[i]?.kind ?? 'other')}
          options={kinds.map((kind) => ({ value: kind, label: t(`admin.people.kind.${kind}`) }))}
        />
        <Field
          id="link-label-{i}"
          name="link.{i}.label"
          label={t('admin.people.linkLabel')}
          locale={data.locale}
          value={value(`link.${i}.label`, links[i]?.label)}
          maxlength={100}
        />
        <Field
          id="link-url-{i}"
          name="link.{i}.url"
          type="url"
          label={t('admin.people.linkUrl')}
          locale={data.locale}
          value={value(`link.${i}.url`, links[i]?.url)}
        />
      </details>
    {/each}
  </Fieldset>
  <Fieldset legend={t('admin.people.settings')} collapsed={!form?.error}>
    <Select
      id="person-policy"
      name="pagePolicy"
      label={t('admin.people.pagePolicy')}
      locale={data.locale}
      hint={t('admin.people.pageHint')}
      value={value('pagePolicy', person?.pagePolicy ?? 'auto')}
      options={(['auto', 'always', 'never'] as const).map((p) => ({
        value: p,
        label: t(`admin.people.policy.${p}`),
      }))}
    />
    {#if !person}<Field
        id="person-slug"
        name="slug"
        label={t('admin.people.slug')}
        locale={data.locale}
        hint={t('admin.people.slugHint')}
        value={value('slug')}
        maxlength={63}
      />{:else}<p>{person.slug}</p>{/if}
  </Fieldset>
</FormPage>
