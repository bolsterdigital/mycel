<!-- "Profile and preferences" (#88, #101), shared by `/admin/voorkeuren` (outside any site) and
     `/admin/[tenant]/profiel` (inside a site's shell, so the admin navigation stays). First the
     account (name and address from the IdP, read only) and the operator's role on each site, then
     three native selects and one save. The language list names each language in itself, so
     someone who cannot read the current one still finds their own.
     Rejected: a copy of this form per route (the two would drift). -->
<script lang="ts">
  import type { OperatorPreferences, Role } from '@mycel/core';
  import { FormPage, MetaList, Notice, Select } from '#lib/admin/ui/index.js';
  import { ui, type UiKey } from '../../i18n/index.js';

  type Props = {
    locale: string;
    data: {
      email: string;
      name?: string | null | undefined;
      sites: readonly { slug: string; name: string; role: Role }[];
      preferences: OperatorPreferences;
      zones: readonly { value: string; label: string }[];
      back: string;
      saved: boolean;
    };
    form: { values: Record<string, unknown>; invalid: string[] } | null | undefined;
  };
  let { locale, data, form }: Props = $props();
  const t = $derived(ui(locale));
  const chosen = (key: 'uiLocale' | 'timeZone' | 'dateFormat'): string =>
    String((form?.values ?? data.preferences)[key] ?? '');
  const invalid = (key: string) =>
    form?.invalid.includes(key) ? t('admin.preferences.invalid') : undefined;
</script>

<FormPage
  title={t('admin.preferences.title')}
  {locale}
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
    size="s"
    name="uiLocale"
    label={t('admin.preferences.language')}
    {locale}
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
    size="m"
    name="timeZone"
    label={t('admin.preferences.timeZone')}
    {locale}
    hint={t('admin.preferences.timeZone.hint')}
    value={chosen('timeZone')}
    error={invalid('timeZone')}
    options={[{ value: '', label: t('admin.preferences.timeZone.site') }, ...data.zones]}
  />
  <Select
    id="dateFormat"
    size="m"
    name="dateFormat"
    label={t('admin.preferences.dateFormat')}
    {locale}
    value={chosen('dateFormat')}
    error={invalid('dateFormat')}
    options={[
      { value: 'relative', label: t('admin.preferences.dateFormat.relative') },
      { value: 'absolute', label: t('admin.preferences.dateFormat.absolute') },
    ]}
  />
</FormPage>
