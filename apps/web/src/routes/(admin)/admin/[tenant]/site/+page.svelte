<!-- Site settings (#11 E) on the settings pattern (brief #56 § B): one subject per URL
     (`?section=`), so the sub-navigation works without JavaScript, and a form with its own save
     per section. The form actions carry the subject (`?section=theme&/theme`), so the page that
     answers a post shows the section that was saved. The contrast of each colour pair is
     recomputed as you pick; core checks it again on save. -->
<script lang="ts">
  import { FONT_PAIRS, THEME_MODES, THEME_ROLES } from '@mycel/core';
  import {
    Actions,
    Button,
    Field,
    Fieldset,
    FileDrop,
    Notice,
    Select,
    SettingsPage,
    SettingsSection,
  } from '#lib/admin/ui/index.js';
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const here = $derived(`${base}/site`);
  const extraRoles = ['link', 'focus'] as const;
  const numericFields = [
    'baseSize',
    'scaleRatio',
    'measure',
    'radius',
    'density',
    'headingWeight',
  ] as const;
  const SUBJECT: Record<(typeof data.sections)[number], UiKey> = {
    theme: 'admin.site.theme',
    brand: 'admin.site.brand',
    chrome: 'admin.site.chrome',
  };
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
    >{form?.problem ? `${t('error.prefix')} ` : ''}{t(SUBJECT[data.section])} · {t(
      'admin.site.title'
    )} · {data.tenant.name}</title
  >
</svelte:head>

<SettingsPage
  title={t('admin.site.title')}
  locale={data.locale}
  breadcrumb={[{ label: data.tenant.name, href: base }, { label: t('admin.site.title') }]}
  description={t('admin.site.lead')}
  nav={{
    label: t('admin.site.sections'),
    items: data.sections.map((section) => ({
      href: section === 'theme' ? here : `${here}?section=${section}`,
      label: t(SUBJECT[section]),
      current: section === data.section,
    })),
  }}
>
  {#snippet notices()}
    {#if form?.problem}
      <Notice tone="error" title={t('error.summary.title')}>
        <p>{form.problem === 'conflict' ? t('admin.site.conflict') : t('admin.site.invalid')}</p>
      </Notice>
    {/if}
  {/snippet}

  {#if data.section === 'theme'}
    <SettingsSection
      id="site-theme"
      title={t('admin.site.theme')}
      action={action('theme')}
      submit={t('admin.site.saveTheme')}
      saved={saved('theme')}
    >
      <input
        type="hidden"
        name="baseVersion"
        value={form?.action === 'theme'
          ? value('baseVersion', String(data.theme.version))
          : data.theme.version}
      />
      {#each THEME_MODES as mode (mode)}
        <Fieldset legend={t(`admin.site.mode.${mode}`)}>
          {#each THEME_ROLES as role (role)}
            <Fieldset legend={t(`admin.site.role.${role}`)}>
              {#each ['foreground', 'background'] as side (side)}
                {@const name = `${mode}.${role}.${side}`}
                <Field
                  id="site-{mode}-{role}-{side}"
                  {name}
                  type="color"
                  label={t(
                    side === 'foreground' ? 'admin.site.foreground' : 'admin.site.background'
                  )}
                  locale={data.locale}
                  value={value(
                    name,
                    data.theme.value.palettes[mode][role][side as 'foreground' | 'background']
                  )}
                  oninput={(event) => {
                    changed[name] = event.currentTarget.value;
                  }}
                />
              {/each}
              <p class="ui-hint">
                <output aria-live="polite"
                  >{t('admin.site.contrast')}: {ratio(mode, role).toFixed(1)}:1 ({ratio(
                    mode,
                    role
                  ) >= 4.5
                    ? t('admin.site.pass')
                    : t('admin.site.fail')})</output
                >
              </p>
            </Fieldset>
          {/each}
          {#each extraRoles as key (key)}
            <Field
              id="site-{mode}-{key}"
              name="{mode}.{key}"
              type="color"
              label={t(`admin.site.role.${key}`)}
              locale={data.locale}
              value={value(`${mode}.${key}`, data.theme.value.palettes[mode][key])}
            />
          {/each}
        </Fieldset>
      {/each}
      <Fieldset legend={t('admin.site.group.type')}>
        <Select
          id="site-font"
          name="fontPair"
          label={t('admin.site.font')}
          locale={data.locale}
          options={FONT_PAIRS.map((font) => ({ value: font, label: font }))}
          value={value('fontPair', data.theme.value.fontPair)}
        />
        {#each numericFields as key (key)}
          <Field
            id="site-{key}"
            name={key}
            type="number"
            step="any"
            required
            label={t(`admin.site.field.${key}`)}
            locale={data.locale}
            value={value(key, String(data.theme.value[key]))}
          />
        {/each}
      </Fieldset>
    </SettingsSection>
  {:else if data.section === 'brand'}
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
  {:else}
    <SettingsSection
      id="site-chrome"
      title={t('admin.site.chrome')}
      description={fill(t('admin.site.linkHint'), { locales: data.tenant.locales.join('|') })}
      action={action('chrome')}
      submit={t('admin.site.saveChrome')}
      saved={saved('chrome')}
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
