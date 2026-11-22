<!-- Where a campaign stands in numbers (ADR 033 rule 8, ADR 038 rule 7), the same on the landing
     page, in a card and in place of a closed form: the figure large with what it counts under it,
     a native <progress> against a public goal, then the goal. With nothing counted yet it says so
     instead of a prominent "0". Only aggregates; nothing when the site hides the counter. The bar
     never runs past full, the figure does. A fundraiser counts money, so figure and goal read as
     amounts. The counter is a paragraph, not a heading (ADR 038 rule 3). Rejected: a count-up
     animation (script, motion, and nothing the figure does not already say). -->
<script lang="ts">
  import { countFigures } from '../campaign-count.js';
  import type { RenderCampaign, RenderModel } from './model.js';

  let {
    campaign,
    model,
    id,
  }: { campaign: Pick<RenderCampaign, 'kind' | 'counter'>; model: RenderModel; id: string } =
    $props();

  const copy = $derived(model.copy.campaign);
  const counter = $derived(campaign.counter);
  const figures = $derived(counter && countFigures(counter, counter.target, model.locale));
  const none = $derived(figures?.value === 0);
</script>

{#if counter && figures}
  <div class="campaign-count">
    <p class="campaign-count-figure" id="{id}-count">
      {#if none}<span>{copy.none[campaign.kind]}</span>{:else}<strong>{figures.count}</strong>
        <span>{copy.unit[campaign.kind]}</span>{/if}
    </p>
    {#if figures.target !== null}
      <progress
        max={counter.target}
        value={Math.min(figures.value, counter.target!)}
        aria-labelledby="{id}-count {id}-goal">{figures.count}</progress
      >
      <p class="campaign-count-goal" id="{id}-goal">
        {copy.goal.replace('{target}', () => figures.target!)}
      </p>
    {/if}
  </div>
{/if}
