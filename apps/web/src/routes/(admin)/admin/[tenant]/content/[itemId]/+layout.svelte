<!-- The campaign panel's and the newsletter panel's own forms (lib/admin/campaigns/CampaignPanel,
     lib/admin/email-preview/EmailPanel): outside the edit screen's form, which holds the side
     column, so the panels' buttons name them by `form`. -->
<script lang="ts">
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();
</script>

{@render children()}
{#if data.campaign}<form id="campaign-form" method="post" hidden></form>{/if}
{#if data.newsletter}<form id="newsletter-form" method="post" hidden></form>{/if}
