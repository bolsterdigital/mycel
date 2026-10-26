<script lang="ts">
  import { ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
</script>

<svelte:head><title>{t('admin.assist.title')}</title></svelte:head>
<main class="page admin">
  <h1>{t('admin.assist.title')}</h1>
  {#if form?.problem}<p role="alert">{t(`admin.assist.error.${form.problem}` as UiKey)}</p>{/if}
  {#if data.saved}<p role="status">{t('admin.assist.saved')}</p>{/if}
  <p>{data.allowed ? t('admin.assist.allowed') : t('admin.assist.unavailable')}</p>
  <p>{t('admin.assist.provider')}: {data.settings.provider ?? t('admin.assist.none')}</p>
  <table>
    <caption>{t('admin.assist.disclosure')}</caption>
    <thead
      ><tr
        ><th scope="col">{t('admin.assist.sent')}</th><th scope="col"
          >{t('admin.assist.notSent')}</th
        ></tr
      ></thead
    >
    <tbody>
      <tr><td>{t('admin.assist.sent.alt')}</td><td>{t('admin.assist.notSent.supporters')}</td></tr>
      <tr><td>{t('admin.assist.sent.translate')}</td><td>{t('admin.assist.notSent.other')}</td></tr>
    </tbody>
  </table>
  <form method="post" action="?/save">
    <label
      ><input
        type="checkbox"
        name="enabled"
        checked={form?.enabled ?? data.settings.enabled}
        disabled={!data.allowed}
      />{t('admin.assist.enable')}</label
    >
    <label><input type="checkbox" name="consent" />{t('admin.assist.consent')}</label>
    <label
      ><input
        type="checkbox"
        name="allowRestricted"
        checked={form?.allowRestricted ?? data.settings.allowRestricted}
        disabled={!data.allowed}
      />{t('admin.assist.restricted')}</label
    >
    <button type="submit">{t('admin.assist.save')}</button>
  </form>
</main>

<style>
  table {
    display: block;
    overflow-x: auto;
    max-width: 100%;
  }
  th,
  td {
    padding: 0.5rem;
    text-align: start;
    vertical-align: top;
  }
  form {
    display: grid;
    gap: 1rem;
    margin-top: 1.5rem;
  }
  label {
    display: flex;
    gap: 0.75rem;
    align-items: start;
  }
  input[type='checkbox'] {
    min-width: 1.5rem;
    min-height: 1.5rem;
  }
  button {
    min-height: 2.75rem;
    justify-self: start;
  }
</style>
