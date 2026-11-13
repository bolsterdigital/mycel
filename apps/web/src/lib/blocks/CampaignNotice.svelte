<!-- In place of a form whose campaign does not accept participation now (ADR 033 rule 2): a
     closed campaign shows its result and no active submit, one that has not opened says so. The
     submit path refuses a stale post anyway (rule 3); this keeps the page from offering one. -->
<script lang="ts">
  import type { RenderCampaign, RenderModel } from './model.js';
  import CampaignCount from './CampaignCount.svelte';

  let {
    campaign,
    model,
    id,
    variant,
    width,
  }: {
    campaign: RenderCampaign;
    model: RenderModel;
    id: string;
    variant: 'default' | 'card';
    width: 'content' | 'wide' | 'full';
  } = $props();
</script>

<div class="block form form-{variant} width-{width} campaign-notice">
  <p class="campaign-notice-text">
    {model.copy.campaign.notOpen[campaign.phase === 'upcoming' ? 'upcoming' : 'closed']}
  </p>
  <CampaignCount {campaign} {model} id="campaign-{id}" />
</div>
