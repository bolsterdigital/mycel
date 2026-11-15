<!-- Where a campaign stands in numbers (ADR 033 rule 8): what it counts, the count, and against a
     public goal a native <progress> named by that line. Only aggregates; nothing when the site
     hides the counter. The bar never runs past full, the number does ("620 of 500"). -->
<script lang="ts">
  import type { RenderCampaign, RenderModel } from './model.js';

  let { campaign, model, id }: { campaign: RenderCampaign; model: RenderModel; id: string } =
    $props();

  const copy = $derived(model.copy.campaign);
  const number = $derived(new Intl.NumberFormat(model.locale));
  const counter = $derived(campaign.counter);
  const figure = $derived(
    counter
      ? counter.target === null
        ? number.format(counter.participants)
        : copy.ofTarget
            .replace('{n}', () => number.format(counter.participants))
            .replace('{target}', () => number.format(counter.target!))
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
      value={Math.min(counter.participants, counter.target)}
      aria-labelledby="{id}-count">{figure}</progress
    >
  {/if}
{/if}
