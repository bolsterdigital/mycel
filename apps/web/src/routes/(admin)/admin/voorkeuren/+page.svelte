<!-- The operator's preferences (#88) on the form pattern: three native selects, one save,
     "back" to where the operator came from. The language list names each language in itself, so
     someone who cannot read the current one still finds their own.
     #101: "Profile and preferences". Before the form, the account (name and address from the
     IdP, read only) and the operator's role on each site, so "who am I here" has one place. -->
<script lang="ts">
  import Header from '#lib/admin/Header.svelte';
  import { FormPage, MetaList, Notice, Select } from '#lib/admin/ui/index.js';
  import { ui, type UiKey } from '../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const chosen = (key: 'uiLocale' | 'timeZone' | 'dateFormat'): string =>
    String((form?.values ?? data.preferences)[key] ?? '');
  const invalid = (key: string) =>
    form?.invalid.includes(key) ? t('admin.preferences.invalid') : undefined;
</script>

<svelte:head>
  <title
    >{form ? `${t('error.prefix')} ` : ''}{t('admin.preferences.title')} · {t('admin.title')}</title
  >
</svelte:head>

<Header locale={data.locale} email={data.email} />
<FormPage
  title={t('admin.preferences.title')}
  locale={data.locale}
  description={t('admin.preferences.description')}
  submit={t('admin.preferences.save')}
  cancel={{ href: data.back, label: t('admin.preferences.back') }}
>
  {#snippet notices()}
    {#if form}
      <Notice tone="error" title={t('error.summary.title')}>
        <p>{t('admin.preferences.invalid')}</p>
      </Notice>
    {:else if data.saved}
      <Notice tone="success"><p>{t('admin.preferences.saved')}</p></Notice>
    {/if}
  {/snippet}
  {#snippet lead()}
    <section aria-labelledby="account">
      <h2 id="account">{t('admin.profile.account')}</h2>
      <MetaList
        items={[
          { term: t('admin.profile.name'), value: data.name ?? t('admin.profile.noName') },
          { term: t('admin.profile.email'), value: data.email },
        ]}
      />
      <p class="ui-hint">{t('admin.profile.idp')}</p>
    </section>
    {#if data.sites.length > 0}
      <section aria-labelledby="sites">
        <h2 id="sites">{t('admin.profile.sites')}</h2>
        <ul>
          {#each data.sites as site (site.slug)}
            <li>
              <a href="/admin/{site.slug}">{site.name}</a>: {t(`admin.role.${site.role}` as UiKey)}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    <h2>{t('admin.profile.preferences')}</h2>
  {/snippet}

  <Select
    id="uiLocale"
    name="uiLocale"
    label={t('admin.preferences.language')}
    locale={data.locale}
    value={chosen('uiLocale')}
    error={invalid('uiLocale')}
    options={[
      { value: '', label: t('admin.preferences.language.browser') },
      { value: 'nl', label: 'Nederlands' },
      { value: 'en', label: 'English' },
    ]}
  />
  <Select
    id="timeZone"
    name="timeZone"
    label={t('admin.preferences.timeZone')}
    locale={data.locale}
    hint={t('admin.preferences.timeZone.hint')}
    value={chosen('timeZone')}
    error={invalid('timeZone')}
    options={[{ value: '', label: t('admin.preferences.timeZone.site') }, ...data.zones]}
  />
  <Select
    id="dateFormat"
    name="dateFormat"
    label={t('admin.preferences.dateFormat')}
    locale={data.locale}
    value={chosen('dateFormat')}
    error={invalid('dateFormat')}
    options={[
      { value: 'relative', label: t('admin.preferences.dateFormat.relative') },
      { value: 'absolute', label: t('admin.preferences.dateFormat.absolute') },
    ]}
  />
</FormPage>
