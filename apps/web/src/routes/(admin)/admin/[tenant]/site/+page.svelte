<!-- Site settings (#11 E) on the settings pattern (brief #56 § B): one subject per URL
     (`?section=`), so the sub-navigation works without JavaScript, and a form with its own save
     per section. The form actions carry the subject (`?section=theme&/theme`), so the page that
     answers a post shows the section that was saved. The contrast of each colour pair is
     recomputed as you pick; core checks it again on save.
     Brief #81 PR 3: General (what the site is called and in which languages, read-only until
     there is a use case to change it; its time zone, #88, with its own save), the look, AI assistance (moved from its own route) and
     usage, each subject shown only to a member who may open it. With JavaScript, a changed form
     says it is not saved yet and leaving asks first (static/_admin/unsaved.js).
     The subjects are the page's `subnav` (#81-rest): the shell shows them under "Settings" in the
     sidebar, so this screen draws no sub-navigation of its own. The brand subject also picks the
     default image items inherit (#81-rest), and the theme whether articles open with a drop cap.
     API access (#101) is the site's API keys, moved from Members (lib/admin/ApiAccess.svelte). -->
<script lang="ts">
  import { DROP_CAPS, FONT_PAIRS, THEME_MODES, THEME_ROLES } from '@mycel/core';
  import {
    Actions,
    Button,
    Checkbox,
    ColorField,
    Field,
    Fieldset,
    FileDrop,
    MediaPicker,
    MetaList,
    Notice,
    Select,
    SettingsPage,
    SettingsSection,
    Table,
  } from '#lib/admin/ui/index.js';
  import ApiAccess from '#lib/admin/ApiAccess.svelte';
  import UsageList from '#lib/admin/UsageList.svelte';
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const extraRoles = ['link', 'focus'] as const;
  const numericFields = [
    'baseSize',
    'scaleRatio',
    'measure',
    'radius',
    'density',
    'headingWeight',
  ] as const;
  /** The unit after a number field (#102); the others are plain ratios or weights. */
  const units: Partial<Record<(typeof numericFields)[number], UiKey>> = {
    baseSize: 'admin.site.unit.px',
    measure: 'admin.site.unit.characters',
    radius: 'admin.site.unit.px',
  };
  const subject = $derived(data.subnav.find((s) => s.current)?.label ?? '');
  const language = $derived(new Intl.DisplayNames([data.locale], { type: 'language' }));
  const named = (locale: string) => `${language.of(locale) ?? locale} (${locale})`;
  const action = (name: string) => `?section=${data.section}&/${name}`;
  const value = (name: string, fallback: string) => String(form?.values?.[name] ?? fallback);
  const row = (links: { href: string; label: Record<string, string> }[]) =>
    links
      .map((item) =>
        [item.href, ...data.tenant.locales.map((locale) => item.label[locale] ?? '')].join('|')
      )
      .join('\n');
  let changed = $state<Record<string, string>>({});
  const colour = (name: string, fallback: string) => changed[name] ?? value(name, fallback);
  const luminance = (hex: string) => {
    const rgb = hex.match(/[a-f\d]{2}/gi)?.map((part) => parseInt(part, 16) / 255) ?? [];
    const linear = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
  };
  const ratio = (mode: 'light' | 'dark', role: (typeof THEME_ROLES)[number]) => {
    const pair = data.theme.value.palettes[mode][role];
    const a = luminance(colour(`${mode}.${role}.foreground`, pair.foreground));
    const b = luminance(colour(`${mode}.${role}.background`, pair.background));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const saved = (what: string) =>
    form && 'saved' in form && form.saved === what ? t('admin.site.saved') : undefined;
  const brandSaved = (kind: 'logo' | 'font') =>
    form && 'saved' in form && form.saved === 'brand' && 'kind' in form && form.kind === kind
      ? t('admin.site.saved')
      : undefined;
</script>

<svelte:head>
  <title
    >{form?.problem || form?.error ? `${t('error.prefix')} ` : ''}{subject} · {t(
      'admin.site.title'
    )} · {data.tenant.name}</title
  >
</svelte:head>

<SettingsPage
  title={t('admin.site.title')}
  locale={data.locale}
  breadcrumb={[{ label: data.tenant.name, href: base }, { label: t('admin.site.title') }]}
  description={t('admin.site.lead')}
>
  {#snippet notices()}
    {#if form?.problem}
      <Notice tone="error" title={t('error.summary.title')}>
        <p>
          {data.section === 'assist'
            ? t(`admin.assist.error.${form.problem}` as UiKey)
            : form.problem === 'conflict'
              ? t('admin.site.conflict')
              : t('admin.site.invalid')}
        </p>
      </Notice>
    {/if}
  {/snippet}

  {#if data.section === 'general'}
    <SettingsSection id="site-general" title={t('admin.site.general')}>
      <MetaList
        items={[
          { term: t('admin.site.general.name'), value: data.tenant.name },
          {
            term: t('admin.site.general.locales'),
            value: data.tenant.locales.map(named).join(', '),
          },
          { term: t('admin.site.general.defaultLocale'), value: named(data.tenant.defaultLocale) },
        ]}
      />
      <p class="ui-hint">{t('admin.site.general.fixed')}</p>
    </SettingsSection>
    <SettingsSection
      id="site-time-zone"
      title={t('admin.site.general.timeZone')}
      action={action('general')}
      submit={t('admin.site.general.save')}
      saved={saved('general')}
      unsaved={t('admin.site.unsaved')}
    >
      <input
        type="hidden"
        name="baseVersion"
        value={form?.action === 'general'
          ? value('baseVersion', String(data.general.version))
          : String(data.general.version)}
      />
      <Select
        id="site-timeZone"
        size="m"
        name="timeZone"
        label={t('admin.site.general.timeZone')}
        locale={data.locale}
        hint={t('admin.site.general.timeZone.hint')}
        value={value('timeZone', data.general.value.timeZone)}
        options={data.zones}
      />
    </SettingsSection>
  {:else if data.section === 'assist' && data.assist}
    {@const assist = data.assist}
    <SettingsSection
      id="site-assist"
      title={t('admin.assist.title')}
      description={assist.allowed ? t('admin.assist.allowed') : t('admin.assist.unavailable')}
      action={action('assist')}
      submit={t('admin.assist.save')}
      saved={assist.saved ? t('admin.assist.saved') : undefined}
      unsaved={t('admin.site.unsaved')}
    >
      <MetaList
        items={[
          {
            term: t('admin.assist.provider'),
            value: assist.settings.provider ?? t('admin.assist.none'),
          },
        ]}
      />
      <Table
        id="site-assist-disclosure"
        caption={t('admin.assist.disclosure')}
        columns={[
          { key: 'sent', label: t('admin.assist.sent') },
          { key: 'notSent', label: t('admin.assist.notSent') },
        ]}
      >
        {#snippet rows()}
          <tr
            ><td>{t('admin.assist.sent.alt')}</td><td>{t('admin.assist.notSent.supporters')}</td
            ></tr
          >
          <tr
            ><td>{t('admin.assist.sent.translate')}</td><td>{t('admin.assist.notSent.other')}</td
            ></tr
          >
        {/snippet}
      </Table>
      <input type="hidden" name="provider" value={assist.settings.provider ?? ''} />
      <Checkbox
        id="site-assist-enabled"
        name="enabled"
        label={t('admin.assist.enable')}
        checked={form?.enabled ?? assist.settings.enabled}
        disabled={!assist.allowed}
      />
      <Checkbox id="site-assist-consent" name="consent" label={t('admin.assist.consent')} />
      <Checkbox
        id="site-assist-restricted"
        name="allowRestricted"
        label={t('admin.assist.restricted')}
        checked={form?.allowRestricted ?? assist.settings.allowRestricted}
        disabled={!assist.allowed}
      />
    </SettingsSection>
  {:else if data.section === 'api' && data.api}
    <ApiAccess
      keys={data.api.keys}
      roles={data.api.roles}
      capabilities={data.api.capabilities}
      locale={data.locale}
      {form}
    />
  {:else if data.section === 'usage' && data.usage}
    <SettingsSection id="site-usage" title={t('admin.dashboard.usage')}>
      {#if data.usage.status === 'suspended'}
        <Notice tone="warning">
          <p>{t('admin.suspended')}</p>
          <p><a href="{base}/export">{t('admin.suspended.export')}</a></p>
        </Notice>
      {/if}
      <UsageList usage={data.usage} locale={data.locale} />
    </SettingsSection>
  {:else if data.section === 'theme'}
    <SettingsSection
      id="site-theme"
      title={t('admin.site.theme')}
      action={action('theme')}
      submit={t('admin.site.saveTheme')}
      saved={saved('theme')}
      unsaved={t('admin.site.unsaved')}
    >
      <input
        type="hidden"
        name="baseVersion"
        value={form?.action === 'theme'
          ? value('baseVersion', String(data.theme.version))
          : data.theme.version}
      />
      <!-- One table per mode (#102): a row per role, its text and background colour and their
           contrast, one outline deep; the extra roles have one colour. Below 36rem the rows
           stack (Table `stack`). Rejected: a fieldset per role inside a fieldset per mode. -->
      {#each THEME_MODES as mode (mode)}
        <Table
          id="site-colours-{mode}"
          caption={t(`admin.site.mode.${mode}`)}
          stack
          columns={[
            { key: 'role', label: t('admin.site.colours.role') },
            { key: 'foreground', label: t('admin.site.foreground') },
            { key: 'background', label: t('admin.site.background') },
            { key: 'contrast', label: t('admin.site.colours.contrast') },
          ]}
        >
          {#snippet rows()}
            {#each THEME_ROLES as role (role)}
              {@const roleLabel = t(`admin.site.role.${role}`)}
              <tr>
                <th scope="row">{roleLabel}</th>
                {#each ['foreground', 'background'] as const as side (side)}
                  {@const name = `${mode}.${role}.${side}`}
                  {@const sideLabel = t(`admin.site.${side}`)}
                  <td data-label={sideLabel}>
                    <ColorField
                      id="site-{mode}-{role}-{side}"
                      {name}
                      label="{roleLabel}: {sideLabel}"
                      hideLabel
                      required
                      locale={data.locale}
                      value={value(name, data.theme.value.palettes[mode][role][side])}
                      onchange={(next) => {
                        changed[name] = next;
                      }}
                    />
                  </td>
                {/each}
                <td data-label={t('admin.site.colours.contrast')}>
                  <output aria-live="polite"
                    >{ratio(mode, role).toFixed(1)}:1 ({ratio(mode, role) >= 4.5
                      ? t('admin.site.pass')
                      : t('admin.site.fail')})</output
                  >
                </td>
              </tr>
            {/each}
            {#each extraRoles as key (key)}
              {@const roleLabel = t(`admin.site.role.${key}`)}
              <tr>
                <th scope="row">{roleLabel}</th>
                <td data-label={t('admin.site.foreground')}>
                  <ColorField
                    id="site-{mode}-{key}"
                    name="{mode}.{key}"
                    label="{roleLabel}: {t('admin.site.foreground')}"
                    hideLabel
                    required
                    locale={data.locale}
                    value={value(`${mode}.${key}`, data.theme.value.palettes[mode][key])}
                  />
                </td>
                <td></td>
                <td></td>
              </tr>
            {/each}
          {/snippet}
        </Table>
      {/each}
      <Fieldset legend={t('admin.site.group.type')}>
        <Select
          id="site-font"
          name="fontPair"
          label={t('admin.site.font')}
          locale={data.locale}
          size="m"
          options={FONT_PAIRS.map((font) => ({ value: font, label: font }))}
          value={value('fontPair', data.theme.value.fontPair)}
        />
        <Select
          id="site-dropCap"
          name="dropCap"
          label={t('admin.site.dropCap')}
          locale={data.locale}
          size="m"
          hint={t('admin.site.dropCap.hint')}
          options={DROP_CAPS.map((d) => ({ value: d, label: t(`admin.site.dropCap.${d}`) }))}
          value={value('dropCap', data.theme.value.dropCap ?? 'articles')}
        />
        {#each numericFields as key (key)}
          <Field
            id="site-{key}"
            name={key}
            type="number"
            step="any"
            required
            label={t(`admin.site.field.${key}`)}
            unit={units[key] && t(units[key])}
            locale={data.locale}
            value={value(key, String(data.theme.value[key]))}
          />
        {/each}
      </Fieldset>
    </SettingsSection>
  {:else if data.section === 'brand'}
    {#if data.images}
      {@const images = data.images}
      <SettingsSection
        id="site-images"
        title={t('admin.site.images')}
        action={action('images')}
        submit={t('admin.site.defaultImage.save')}
        saved={saved('images')}
        unsaved={t('admin.site.unsaved')}
      >
        <input
          type="hidden"
          name="baseVersion"
          value={form?.action === 'images'
            ? value('baseVersion', String(images.version))
            : images.version}
        />
        <MediaPicker
          id="site-defaultImageId"
          name="defaultImageId"
          label={t('admin.site.defaultImage')}
          hint={t('admin.site.defaultImage.hint')}
          locale={data.locale}
          value={value('defaultImageId', images.value.defaultImageId ?? '')}
          options={images.media}
          {base}
          upload={images.upload}
          invalid={form?.action === 'images'}
        />
      </SettingsSection>
    {/if}
    {#each ['logo', 'font'] as const as kind (kind)}
      {@const state = kind === 'logo' ? data.logo : data.font}
      <SettingsSection
        id="site-{kind}"
        title={t(kind === 'logo' ? 'admin.site.logo' : 'admin.site.wordmarkFont')}
        description={state.active ? t('admin.site.active') : undefined}
        action={action('brand')}
        enctype="multipart/form-data"
        submit={t('admin.site.upload')}
        saved={brandSaved(kind)}
        unsaved={t('admin.site.unsaved')}
      >
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="baseVersion" value={state.version} />
        {#if state.active && kind === 'logo'}
          <img
            class="site-logo"
            src="{base}/preview/_brand/logo/{state.version}.webp"
            width={state.width ?? 1}
            height={state.height ?? 1}
            alt={data.tenant.name}
          />
        {/if}
        <FileDrop
          id="site-{kind}-file"
          name="file"
          label={t('admin.site.file')}
          locale={data.locale}
          accept={kind === 'logo'
            ? 'image/svg+xml,image/png,image/jpeg,image/webp,image/avif,image/gif'
            : '.woff2,font/woff2'}
        />
        {#if kind === 'font'}
          <Field
            id="site-font-licence"
            name="licence"
            label={t('admin.site.licence')}
            locale={data.locale}
            hint={state.active && state.licence
              ? `${t('admin.site.active')}: ${state.licence}`
              : undefined}
            maxlength={500}
            required
          />
        {/if}
        {#snippet actions()}
          <Actions>
            <Button name="intent" value="upload"
              >{t(state.active ? 'admin.site.replace' : 'admin.site.upload')}</Button
            >
            {#if state.active}
              <Button variant="danger" name="intent" value="remove" formnovalidate
                >{t('admin.site.remove')}</Button
              >
            {/if}
          </Actions>
        {/snippet}
      </SettingsSection>
    {/each}
  {:else if data.section === 'chrome'}
    <SettingsSection
      id="site-chrome"
      title={t('admin.site.chrome')}
      description={fill(t('admin.site.linkHint'), { locales: data.tenant.locales.join('|') })}
      action={action('chrome')}
      submit={t('admin.site.saveChrome')}
      saved={saved('chrome')}
      unsaved={t('admin.site.unsaved')}
    >
      <input
        type="hidden"
        name="baseVersion"
        value={form?.action === 'chrome'
          ? value('baseVersion', String(data.chrome.version))
          : data.chrome.version}
      />
      <Field id="site-navigation" label={t('admin.site.navigation')} locale={data.locale}>
        {#snippet control(attributes)}
          <textarea name="navigation" rows="5" {...attributes}
            >{value('navigation', row(data.chrome.value.navigation))}</textarea
          >
        {/snippet}
      </Field>
      <Fieldset legend={t('admin.site.footer')}>
        {#each data.tenant.locales as locale (locale)}
          <Field
            id="site-footer-{locale}"
            name="footer.{locale}"
            label={locale}
            lang={locale}
            locale={data.locale}
            value={value(`footer.${locale}`, data.chrome.value.footer[locale] ?? '')}
          />
        {/each}
      </Fieldset>
      <Field id="site-legal" label={t('admin.site.legal')} locale={data.locale}>
        {#snippet control(attributes)}
          <textarea name="legal" rows="3" {...attributes}
            >{value('legal', row(data.chrome.value.legal))}</textarea
          >
        {/snippet}
      </Field>
      {#each ['support', 'help'] as const as kind (kind)}
        <Fieldset legend={t(kind === 'support' ? 'admin.site.support' : 'admin.site.help')}>
          <Field
            id="site-{kind}-href"
            name="{kind}.href"
            label={t('admin.site.url')}
            locale={data.locale}
            value={value(`${kind}.href`, data.chrome.value[kind]?.href ?? '')}
          />
          {#each data.tenant.locales as locale (locale)}
            <Field
              id="site-{kind}-{locale}"
              name="{kind}.{locale}"
              label={locale}
              lang={locale}
              locale={data.locale}
              value={value(`${kind}.${locale}`, data.chrome.value[kind]?.label[locale] ?? '')}
            />
          {/each}
        </Fieldset>
      {/each}
    </SettingsSection>
  {/if}
</SettingsPage>

<style>
  /* The active logo as a small sample beside its file field, never at its full intrinsic size. */
  .site-logo {
    inline-size: auto;
    block-size: auto;
    max-inline-size: 12rem;
    max-block-size: 4rem;
  }
</style>
