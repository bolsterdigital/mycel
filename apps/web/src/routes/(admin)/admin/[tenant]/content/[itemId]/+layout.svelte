<!-- The campaign panel's own form (lib/admin/campaigns/CampaignPanel.svelte): outside the edit
     screen's form, which holds the side column, so the panel's controls name it by `form`. -->
<script lang="ts">
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();
</script>

{@render children()}
{#if data.campaign}<form id="campaign-form" method="post" hidden></form>{/if}
