<!-- A public page that is not there or failed: in the page's language, inside the site's header and
     footer, with a way home (ADR 007, 009). The status decides the copy; the message of an error is
     never shown, so nothing internal reaches a visitor. Rejected: the framework's default page,
     which has no title and no language, and leaves the visitor outside the site. -->
<script lang="ts">
  import { page } from '$app/state';
  import { FALLBACK_LANG, ui } from '../../i18n/index.js';

  const t = $derived(ui(String(page.data['locale'] ?? FALLBACK_LANG)));
  const missing = $derived(page.status === 404);
  const chrome = $derived(page.data['chrome'] as { name: string; home: string } | null | undefined);
  const title = $derived(t(missing ? 'public.notFound.title' : 'public.error.title'));
</script>

<svelte:head>
  <title>{chrome ? `${title} · ${chrome.name}` : title}</title>
</svelte:head>

<main class="page">
  <h1>{title}</h1>
  <p>{t(missing ? 'public.notFound.body' : 'public.error.body')}</p>
  {#if chrome}<p><a href={chrome.home}>{t('public.home')}</a></p>{/if}
</main>
