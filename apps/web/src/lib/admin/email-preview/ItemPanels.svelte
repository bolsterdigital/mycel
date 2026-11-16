<!-- The edit screen's side panels that belong to what the item is: a landing page's campaign
     (ADR 033), an article's newsletter. One component, so the edit route stays under its
     size ceiling (scripts/gates/file-size.test.mjs) as panels are added. The newsletter links to
     the e-mail preview under the edit screen's own address; that page opens in the language the
     editor is working in (the content-locale cookie), like the edit screen itself. -->
<script lang="ts">
  import { page } from '$app/state';
  import CampaignPanel from '../campaigns/CampaignPanel.svelte';
  import EmailPanel from './EmailPanel.svelte';
  import type { ComponentProps } from 'svelte';

  let {
    campaign,
    article,
    locale,
  }: {
    campaign: Omit<ComponentProps<typeof CampaignPanel>, 'locale'> | null;
    article: boolean;
    locale: string;
  } = $props();
</script>

{#if campaign}<CampaignPanel {...campaign} {locale} />{/if}
{#if article}<EmailPanel href="{page.url.pathname.replace(/\/$/, '')}/email" {locale} />{/if}
