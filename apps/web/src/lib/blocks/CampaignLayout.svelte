<!-- A campaign's landing page in the campaign layout (ADR 038 rules 1-3, brief campaign-layout):
     the header image first on the wide rail with its per-locale alt, loaded eagerly as the
     likely largest paint; then intro (kind, the title as the page's only h1, lead), the action
     area (count and form, or where participation stands) and the body (the page's own blocks,
     open, headings from h2). DOM, reading and tab order is intro, action, body; campaign.css puts
     the action beside intro and body once the container is wide enough, and keeps one column in
     that order otherwise. The same markup on the public page and in both previews. The card
     reuses the action area and the classes in a structure of its own (MY-267 PR 3). Rejected:
     the predecessor's CSS background image (no alt, no LCP hint) and overlap with negative
     margins, which bled into content above it. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import CampaignAction from './CampaignAction.svelte';
  import Credit from './Credit.svelte';
  import Picture from './Picture.svelte';
  import { IMAGE_SIZES } from './sizes.js';
  import type { FormState, RenderIntro, RenderLanding, RenderModel } from './model.js';

  let {
    campaign,
    intro,
    model,
    state = null,
    preview = null,
    note = null,
    children,
  }: {
    campaign: RenderLanding;
    intro: RenderIntro;
    model: RenderModel;
    state?: FormState | null;
    preview?: string | null;
    note?: string | null;
    /** The body: the page's blocks at depth 1. */
    children: Snippet;
  } = $props();

  const copy = $derived(model.copy.campaign);
</script>

{#if intro.hero}
  <figure class="block image layout-wide page-hero campaign-hero">
    <Picture image={intro.hero} base={model.base} sizes={IMAGE_SIZES.wide} eager />
    {#if intro.hero.caption || intro.hero.credit}
      <figcaption>
        {#if intro.hero.caption}{intro.hero.caption}{/if}
        {#if intro.hero.credit}<Credit
            credit={intro.hero.credit}
            words={model.copy.credit}
            base={model.base}
          />{/if}
      </figcaption>
    {/if}
  </figure>
{/if}
<div class="campaign-layout layout-wide">
  <header class="campaign-intro">
    <p class="campaign-kind">
      {copy.kind[campaign.kind]}{campaign.phase === 'open'
        ? ''
        : ` · ${copy.phase[campaign.phase]}`}
    </p>
    <h1>{model.title}</h1>
    {#if intro.lead}<p class="lead">{intro.lead}</p>{/if}
  </header>
  <CampaignAction {campaign} {model} id="campaign" level={2} {state} {preview} {note} />
  <div class="campaign-body">{@render children()}</div>
</div>
