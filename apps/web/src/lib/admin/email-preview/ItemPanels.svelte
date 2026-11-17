<!-- The edit screen's side panels that belong to what the item is: a landing page's campaign
     (ADR 033), an article's newsletter. One component, so the edit route stays under its
     size ceiling (scripts/gates/file-size.test.mjs) as panels are added; the newsletter's data comes
     from the item's layout and the editor's values from the page itself, read here rather than
     passed through the route. -->
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

  type Newsletter = Omit<ComponentProps<typeof EmailPanel>, 'locale' | 'values' | 'canWrite'>;
  const newsletter = $derived(page.data['newsletter'] as Newsletter | null | undefined);
  const posted = $derived(
    page.form && 'values' in page.form
      ? (page.form['values'] as Record<string, string | string[]>)
      : null
  );
  const values = $derived(
    posted ?? (page.data['values'] as Record<string, string | string[]> | undefined) ?? {}
  );
</script>

{#if campaign}<CampaignPanel {...campaign} {locale} />{/if}
{#if article && newsletter}
  <EmailPanel {...newsletter} {locale} {values} canWrite={page.data['canWrite'] === true} />
{/if}
