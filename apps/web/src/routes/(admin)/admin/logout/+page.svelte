<script lang="ts">
  import { ui } from '../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const done = $derived(!!form?.loggedOut || !data.signedIn);
</script>

<svelte:head>
  <title>{done ? t('admin.loggedOut.title') : t('admin.logout')} · {t('admin.title')}</title>
</svelte:head>

<main class="page admin">
  {#if done}
    <h1>{t('admin.loggedOut.title')}</h1>
    <p>{t('admin.loggedOut.body')}</p>
    <p><a href="/admin">{t('admin.login.again')}</a></p>
  {:else}
    <h1>{t('admin.logout')}</h1>
    <form method="post">
      <button type="submit">{t('admin.logout')}</button>
    </form>
  {/if}
</main>
