<!-- Where a campaign stands in numbers (ADR 033 rule 8): what it counts, the count, and against a
     public goal a native <progress> named by that line. Only aggregates; nothing when the site
     hides the counter. The bar never runs past full, the number does ("620 of 500"). A fundraiser
     counts money, so count and goal read as amounts ("€ 1.250 of € 5.000"). -->
<script lang="ts">
  import { countFigures } from '../campaign-count.js';
  import type { RenderCampaign, RenderModel } from './model.js';

  let { campaign, model, id }: { campaign: RenderCampaign; model: RenderModel; id: string } =
    $props();

  const copy = $derived(model.copy.campaign);
  const counter = $derived(campaign.counter);
  const figures = $derived(counter && countFigures(counter, counter.target, model.locale));
  const figure = $derived(
    figures
      ? figures.target === null
        ? figures.count
        : copy.ofTarget
            .replace('{n}', () => figures.count)
            .replace('{target}', () => figures.target!)
      : ''
  );
</script>

{#if counter}
  <p class="campaign-count" id="{id}-count">
    <span>{copy.unit[campaign.kind]}</span>
    <strong>{figure}</strong>
  </p>
  {#if counter.target !== null}
    <progress
      max={counter.target}
      value={Math.min(figures!.value, counter.target)}
      aria-labelledby="{id}-count">{figure}</progress
    >
  {/if}
{/if}
