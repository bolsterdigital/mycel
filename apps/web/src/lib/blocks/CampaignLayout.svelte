<!-- A campaign in the campaign layout (ADR 038 rules 1-5), on its landing page and in a full card:
     the same areas and classes, the context deciding only the elements. On the landing page the
     header image opens the layout across its full width with its per-locale alt, loaded eagerly
     as the likely largest paint, and shares rows with the columns so intro and action area slide
     into it (ADR 038 amendment of 2026-11-22, MY-276); then intro (kind, the title as the page's
     only h1, lead), the action area with its own h2 (count and form, or where participation
     stands) and the body (the page's own blocks, open, headings from h2). In a card (`card`) the
     image is decorative and lazy (the title names the card), the intro is a div whose title sits
     at the card's level and links to the landing page, the action area has no heading of its own,
     and the body is the campaign's text, open; a long one carries the words of the "read more"
     button that `campaign-body.js` adds (ADR 038 amendment, item 2), and without the script it
     stands whole. DOM, reading
     and tab order is intro, action, body; campaign.css puts the action beside intro and body once
     the container is wide enough, and keeps one column in that order otherwise. The landing
     page's thank-you view (ADR 038 rule 8) is the landing page's layout with the thanks as lead,
     the count without a heading and share links as body. Rejected: the predecessor's CSS
     background image (no alt, no LCP hint), overlap with negative margins, which bled into
     content above it, and a second card component (the drift between card and page is what this
     layout ends). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import CampaignAction from './CampaignAction.svelte';
  import Credit from './Credit.svelte';
  import Picture from './Picture.svelte';
  import { headingTag } from './headings.js';
  import { withBase } from './rich-text.js';
  import { IMAGE_SIZES } from './sizes.js';
  import { CAMPAIGN_BODY_SCRIPT } from './card-body.js';
  import type { FormState, RenderImage, RenderIntro, RenderLanding, RenderModel } from './model.js';

  let {
    campaign,
    intro = null,
    card = null,
    model,
    actionHeading = true,
    id = 'campaign',
    state = null,
    preview = null,
    note = null,
    children,
  }: {
    campaign: RenderLanding;
    /** The landing page's own header: its lead and header image. */
    intro?: RenderIntro | null;
    /** In a card: its title, level, link, image and how the body shows (ADR 038 rule 4). */
    card?: {
      title: string;
      lead: string | null;
      level: number;
      href: string;
      image: RenderImage | null;
      sizes: string;
      /** Whether a long body may be shortened with "read more" (campaign-body.js). */
      clamp: boolean;
    } | null;
    model: RenderModel;
    /** The action area's own heading; off on the thank-you view, where the count stands alone. */
    actionHeading?: boolean;
    /** The prefix of every element id in the layout. */
    id?: string;
    state?: FormState | null;
    preview?: string | null;
    note?: string | null;
    /** The body: the page's blocks, or the campaign's text in a card. */
    children?: Snippet;
  } = $props();

  const copy = $derived(model.copy.campaign);
  const lead = $derived(card ? card.lead : (intro?.lead ?? null));
  const hero = $derived(card ? !!card.image : !!intro?.hero);
</script>

<svelte:head>
  {#if card?.clamp}<script type="module" src={CAMPAIGN_BODY_SCRIPT}></script>{/if}
</svelte:head>

<div
  class="campaign-layout"
  class:campaign-landing={!card}
  class:layout-full={!card}
  class:campaign-with-hero={hero}
>
  {#if card}
    {#if card.image}
      <div class="campaign-hero">
        <Picture image={card.image} base={model.base} sizes={card.sizes} />
      </div>
    {/if}
  {:else if intro?.hero}
    <figure class="campaign-hero">
      <Picture image={intro.hero} base={model.base} sizes={IMAGE_SIZES.full} eager />
      {#if intro.hero.caption || intro.hero.credit}
        <figcaption>
          {#if intro.hero.caption}<span class="caption-text">{intro.hero.caption}</span>{/if}
          {#if intro.hero.credit}<Credit
              credit={intro.hero.credit}
              words={model.copy.credit}
              base={model.base}
            />{/if}
        </figcaption>
      {/if}
    </figure>
  {/if}
  <svelte:element this={card ? 'div' : 'header'} class="campaign-intro">
    <p class="campaign-kind">
      {copy.kind[campaign.kind]}{campaign.phase === 'open'
        ? ''
        : ` · ${copy.phase[campaign.phase]}`}
    </p>
    {#if card}
      <svelte:element this={headingTag(card.level)} id="{id}-title"
        ><a href={withBase(model.base, card.href)}>{card.title}</a></svelte:element
      >
    {:else}
      <h1>{model.title}</h1>
    {/if}
    {#if lead}<p class="lead">{lead}</p>{/if}
  </svelte:element>
  <CampaignAction
    {campaign}
    {model}
    {id}
    level={card || !actionHeading ? null : 2}
    {state}
    {preview}
    {note}
  />
  {#if children}
    {#if card}
      <div class="campaign-body">
        {#if card.clamp}
          <div
            class="campaign-text"
            id="{id}-text"
            data-more={copy.readMore}
            data-less={copy.readLess}
          >
            {@render children()}
          </div>
        {:else}
          <div class="campaign-text">{@render children()}</div>
        {/if}
      </div>
    {:else}
      <div class="campaign-body">{@render children()}</div>
    {/if}
  {/if}
</div>
