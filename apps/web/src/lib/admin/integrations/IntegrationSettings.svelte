<!-- Settings, General, Integrations (docs/reference/integrations.md): which entries of the
     reviewed catalogue this site switches on. Only for `tenant:admin`, like measurement. Each
     entry says who makes it and what it loads; nothing here takes an address or a script. The tag
     manager takes its container, the consent it waits for and the vendors its tags may reach;
     switching it off keeps those values. One form and one save, so no action group.
     Rejected: one form per integration (a second version to race, and three saves for one
     decision), and hiding the origins (an administrator should see what visitors' browsers will
     contact before switching it on). -->
<script lang="ts">
  import {
    CONSENT_CATEGORIES,
    INTEGRATION_IDS,
    INTEGRATIONS,
    TAG_VENDOR_IDS,
    TAG_VENDORS,
    type IntegrationSettings,
  } from '@mycel/core';
  import { Checkbox, Choices, Field, Fieldset, Notice, SettingsSection } from '../ui/index.js';
  import { fill, ui } from '../../../i18n/index.js';

  let {
    state,
    locale,
    action,
    saved,
    values,
  }: {
    state: { version: number; value: IntegrationSettings };
    locale: string;
    action: string;
    saved?: string | undefined;
    /** The posted values after a refused save, so nothing typed is lost. */
    values?: Record<string, FormDataEntryValue> | undefined;
  } = $props();

  const t = $derived(ui(locale));
  const gtm = $derived(state.value['google-tag-manager']);
  const on = (name: string, stored: boolean) => (values ? values[name] === 'on' : stored);
  const posted = (name: string, stored: string) => (values ? String(values[name] ?? '') : stored);
  /** What an entry loads, for the administrator: its hosts, without scheme. */
  const hosts = (origins: readonly string[]) =>
    origins.map((origin) => origin.replace(/^https:\/\//, '')).join(', ');
  const enabled = $derived(
    INTEGRATION_IDS.filter((id) => state.value[id].enabled).map((id) => INTEGRATIONS[id].name)
  );
</script>

<SettingsSection
  id="site-integrations"
  title={t('admin.site.integrations.title')}
  description={enabled.length
    ? fill(t('admin.site.integrations.on'), { names: enabled.join(', ') })
    : t('admin.site.integrations.off')}
  {action}
  submit={t('admin.site.integrations.save')}
  {saved}
  unsaved={t('admin.site.unsaved')}
>
  <input
    type="hidden"
    name="baseVersion"
    value={values ? String(values.baseVersion ?? state.version) : String(state.version)}
  />
  {#each ['youtube', 'vimeo'] as const as id (id)}
    <Checkbox
      id="site-integrations-{id}"
      name={id}
      label={fill(t('admin.site.integrations.embed'), { name: INTEGRATIONS[id].name })}
      hint={fill(t('admin.site.integrations.embed.hint'), {
        name: INTEGRATIONS[id].name,
        hosts: hosts(INTEGRATIONS[id].csp.frame),
      })}
      checked={on(id, state.value[id].enabled)}
    />
  {/each}
  <Fieldset legend={INTEGRATIONS['google-tag-manager'].name}>
    <Notice tone="warning">
      <p>{t('admin.site.integrations.gtm.warning')}</p>
    </Notice>
    <Checkbox
      id="site-integrations-gtm"
      name="gtm"
      label={t('admin.site.integrations.gtm.enable')}
      hint={fill(t('admin.site.integrations.gtm.hint'), {
        hosts: hosts(INTEGRATIONS['google-tag-manager'].csp.script),
      })}
      checked={on('gtm', gtm.enabled)}
    />
    <Field
      id="site-integrations-gtm-container"
      name="gtmContainer"
      label={t('admin.site.integrations.gtm.container')}
      {locale}
      hint={t('admin.site.integrations.gtm.container.hint')}
      value={posted('gtmContainer', gtm.containerId ?? '')}
      maxlength={16}
      autocomplete="off"
      spellcheck="false"
    />
    <Choices
      id="site-integrations-gtm-category"
      name="gtmCategory"
      legend={t('admin.site.integrations.gtm.category')}
      {locale}
      options={CONSENT_CATEGORIES.map((value) => ({
        value,
        label: t(`admin.site.integrations.consent.${value}`),
      }))}
      selected={[posted('gtmCategory', gtm.category)]}
    />
    <Choices
      id="site-integrations-gtm-vendors"
      name="gtmVendors"
      type="checkbox"
      legend={t('admin.site.integrations.gtm.vendors')}
      hint={t('admin.site.integrations.gtm.vendors.hint')}
      {locale}
      options={TAG_VENDOR_IDS.map((value) => ({ value, label: TAG_VENDORS[value].name }))}
      selected={gtm.vendors}
    />
  </Fieldset>
</SettingsSection>
