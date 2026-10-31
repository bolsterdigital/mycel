<!-- Profile and preferences inside the site's shell; the form is `lib/admin/Profile.svelte`. -->
<script lang="ts">
  import Profile from '#lib/admin/Profile.svelte';
  import { ui } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
</script>

<svelte:head>
  <title
    >{form ? `${t('error.prefix')} ` : ''}{t('admin.preferences.title')} · {data.tenant.name}</title
  >
</svelte:head>

<Profile locale={data.locale} {data} {form} />
