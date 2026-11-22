<!-- A campaign in the campaign layout (ADR 038 rules 1-5), on its landing page and in a full card:
     the same areas and classes, the context deciding only the elements. On the landing page the
     header image comes first on the wide rail with its per-locale alt, loaded eagerly as the
     likely largest paint; then intro (kind, the title as the page's only h1, lead), the action
     area with its own h2 (count and form, or where participation stands) and the body (the
     page's own blocks, open, headings from h2). In a card (`card`) the image is decorative and
     lazy (the title names the card), the intro is a div whose title sits at the card's level and
     links to the landing page, the action area has no heading of its own, and the body is the
     campaign's text in a native `<details>` unless it is short. DOM, reading and tab order is
     intro, action, body; campaign.css puts the action beside intro and body once the container is
     wide enough, and keeps one column in that order otherwise. Rejected: the predecessor's CSS
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
  import type { FormState, RenderImage, RenderIntro, RenderLanding, RenderModel } from './model.js';

  let {
    campaign,
    intro = null,
    card = null,
    model,
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
      /** The `<summary>` of a folded body; null shows it open. */
      fold: string | null;
    } | null;
    model: RenderModel;
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
</script>

{#if card}
  {#if card.image}
    <div class="campaign-hero">
      <Picture image={card.image} base={model.base} sizes={card.sizes} />
    </div>
  {/if}
{:else if intro?.hero}
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
<div class="campaign-layout" class:layout-wide={!card}>
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
  <CampaignAction {campaign} {model} {id} level={card ? null : 2} {state} {preview} {note} />
  {#if children}
    {#if card?.fold}
      <details class="campaign-body">
        <summary>{card.fold}</summary>
        {@render children()}
      </details>
    {:else}
      <div class="campaign-body">{@render children()}</div>
    {/if}
  {/if}
</div>
