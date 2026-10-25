<script lang="ts">
  import { FONT_PAIRS, THEME_MODES, THEME_ROLES } from '@mycel/core';
  import { fill, ui } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const extraRoles = ['link', 'focus'] as const;
  const numericFields = [
    'baseSize',
    'scaleRatio',
    'measure',
    'radius',
    'density',
    'headingWeight',
  ] as const;
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
</script>

<svelte:head><title>{t('admin.site.title')}</title></svelte:head>
<div class="admin-page">
  <h1>{t('admin.site.title')}</h1>
  {#if form?.problem}<p role="alert">
      {form.problem === 'conflict' ? t('admin.site.conflict') : t('admin.site.invalid')}
    </p>{/if}
  {#if form?.saved}<p role="status">{t('admin.site.saved')}</p>{/if}
  <section>
    <h2>{t('admin.site.theme')}</h2>
    <form method="post" action="?/theme">
      <input
        type="hidden"
        name="baseVersion"
        value={form?.action === 'theme'
          ? value('baseVersion', String(data.theme.version))
          : data.theme.version}
      />
      {#each THEME_MODES as mode}
        <fieldset>
          <legend>{t(`admin.site.mode.${mode}`)}</legend>
          {#each THEME_ROLES as role}
            <div class="site-color-pair">
              <strong>{t(`admin.site.role.${role}`)}</strong>
              <label
                >{t('admin.site.foreground')}<input
                  type="color"
                  name="{mode}.{role}.foreground"
                  value={value(
                    `${mode}.${role}.foreground`,
                    data.theme.value.palettes[mode][role].foreground
                  )}
                  oninput={(event) => {
                    changed[`${mode}.${role}.foreground`] = event.currentTarget.value;
                  }}
                /></label
              >
              <label
                >{t('admin.site.background')}<input
                  type="color"
                  name="{mode}.{role}.background"
                  value={value(
                    `${mode}.${role}.background`,
                    data.theme.value.palettes[mode][role].background
                  )}
                  oninput={(event) => {
                    changed[`${mode}.${role}.background`] = event.currentTarget.value;
                  }}
                /></label
              >
              <output aria-live="polite"
                >{t('admin.site.contrast')}: {ratio(mode, role).toFixed(1)}:1 ({ratio(mode, role) >=
                4.5
                  ? t('admin.site.pass')
                  : t('admin.site.fail')})</output
              >
            </div>
          {/each}
          {#each extraRoles as key}
            <label
              >{t(`admin.site.role.${key}`)}<input
                type="color"
                name="{mode}.{key}"
                value={value(
                  `${mode}.${key}`,
                  data.theme.value.palettes[mode][key as 'link' | 'focus']
                )}
              /></label
            >
          {/each}
        </fieldset>
      {/each}
      <label
        >{t('admin.site.font')}<select name="fontPair"
          >{#each FONT_PAIRS as font}<option
              value={font}
              selected={value('fontPair', data.theme.value.fontPair) === font}>{font}</option
            >{/each}</select
        ></label
      >
      {#each numericFields as key}
        <label
          >{t(`admin.site.field.${key}`)}<input
            type="number"
            name={key}
            step="any"
            value={value(key, String(data.theme.value[key as 'baseSize']))}
            required
          /></label
        >
      {/each}
      <button type="submit">{t('admin.site.saveTheme')}</button>
    </form>
  </section>
  <section>
    <h2>{t('admin.site.chrome')}</h2>
    <p>{fill(t('admin.site.linkHint'), { locales: data.tenant.locales.join('|') })}</p>
    <form method="post" action="?/chrome">
      <input
        type="hidden"
        name="baseVersion"
        value={form?.action === 'chrome'
          ? value('baseVersion', String(data.chrome.version))
          : data.chrome.version}
      />
      <label
        >{t('admin.site.navigation')}<textarea name="navigation" rows="5"
          >{value('navigation', row(data.chrome.value.navigation))}</textarea
        ></label
      >
      {#each data.tenant.locales as locale (locale)}
        <label
          >{t('admin.site.footer')} ({locale})<input
            name="footer.{locale}"
            value={value(`footer.${locale}`, data.chrome.value.footer[locale] ?? '')}
          /></label
        >
      {/each}
      <label
        >{t('admin.site.legal')}<textarea name="legal" rows="3"
          >{value('legal', row(data.chrome.value.legal))}</textarea
        ></label
      >
      {#each ['support', 'help'] as kind (kind)}
        <fieldset>
          <legend>{kind === 'support' ? t('admin.site.support') : t('admin.site.help')}</legend>
          <label
            >{t('admin.site.url')}<input
              name="{kind}.href"
              value={value(
                `${kind}.href`,
                data.chrome.value[kind as 'support' | 'help']?.href ?? ''
              )}
            /></label
          >
          {#each data.tenant.locales as locale (locale)}
            <label
              >{locale}<input
                name="{kind}.{locale}"
                value={value(
                  `${kind}.${locale}`,
                  data.chrome.value[kind as 'support' | 'help']?.label[locale] ?? ''
                )}
              /></label
            >
          {/each}
        </fieldset>
      {/each}
      <button type="submit">{t('admin.site.saveChrome')}</button>
    </form>
  </section>
</div>

<style>
  .admin-page {
    max-width: 54rem;
    padding: 1rem;
  }
  form {
    display: grid;
    gap: 1rem;
  }
  label {
    display: grid;
    gap: 0.3rem;
    min-width: 0;
  }
  input,
  select,
  textarea {
    max-width: 100%;
    min-height: 2.75rem;
  }
  textarea {
    width: 100%;
  }
  fieldset {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }
  .site-color-pair {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    align-items: center;
  }
  .site-color-pair strong {
    min-width: 5rem;
  }
  button {
    min-height: 2.75rem;
    justify-self: start;
  }
</style>
