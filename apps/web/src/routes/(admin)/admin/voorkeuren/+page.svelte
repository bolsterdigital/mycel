<!-- The operator's profile and preferences outside any site (from the site picker); the form is
     `lib/admin/Profile.svelte`, shared with `/admin/[tenant]/profiel` inside a site's shell. -->
<script lang="ts">
  import Header from '#lib/admin/Header.svelte';
  import Profile from '#lib/admin/Profile.svelte';
  import { ui } from '../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
</script>

<svelte:head>
  <title
    >{form ? `${t('error.prefix')} ` : ''}{t('admin.preferences.title')} · {t('admin.title')}</title
  >
</svelte:head>

<Header locale={data.locale} email={data.email} />
<Profile locale={data.locale} {data} {form} />
