<!-- A campaign card (ADR 033 rule 4, ADR 038 rules 3-5): the campaign as its landing page shows it
     now, as a reference, never a copy. Full is the campaign layout of the landing page in a card's
     elements (`CampaignLayout`): the decorative image, the intro with the title at the card's
     level linking to the page, the action area without a heading of its own (count and form, or
     where participation stands) and the campaign's text from the same revision, folded in a
     native `<details>` unless it is short, with a link to the page when it leaves blocks out.
     Compact stays a teaser on the same intro and count: image beside text, one link to the
     landing page that invites taking part only while participation is open. Outside open
     participation both keep their layout. An unavailable campaign renders nothing here;
     Blocks.svelte shows the preview's diagnosis instead. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { headingTag } from './headings.js';
  import type { FormState, RenderBlock, RenderLanding, RenderModel } from './model.js';
  import { withBase } from './rich-text.js';
  import CampaignAction from './CampaignAction.svelte';
  import CampaignLayout from './CampaignLayout.svelte';
  import Picture from './Picture.svelte';

  let {
    block,
    model,
    state,
    preview = null,
    anchor,
    depth,
    body,
  }: {
    block: Extract<RenderBlock, { type: 'campaign-card' }>;
    model: RenderModel;
    state: FormState | null | undefined;
    preview?: string | null;
    /** The element id a link to this block lands on (`anchor.ts`). */
    anchor?: string;
    /** The heading depth the block sits under (1: under the document title); its own title is one deeper. */
    depth: number;
    /** Renders the card's text blocks one level under the card title (Blocks.svelte). */
    body: Snippet<[RenderBlock[]]>;
  } = $props();

  const copy = $derived(model.copy.campaign);
  const id = $derived(`campaign-${block.id}`);
  const sizes = $derived(
    block.width === 'content'
      ? '(min-width: 48rem) 16rem, 100vw'
      : '(min-width: 48rem) 24rem, 100vw'
  );
  /** What the action area shows: the shared shape of the landing page's campaign. */
  const action = $derived<RenderLanding | null>(
    block.campaign
      ? {
          kind: block.campaign.kind,
          phase: block.campaign.phase,
          opens: block.campaign.opens,
          counter: block.campaign.counter,
          form: block.form,
        }
      : null
  );
</script>

{#snippet text()}
  {#if block.body && block.campaign}
    {@render body(block.body.blocks)}
    {#if block.body.more}
      <p><a href={withBase(model.base, block.campaign.href)}>{copy.readOn}</a></p>
    {/if}
  {/if}
{/snippet}

{#if block.campaign && action}
  {@const c = block.campaign}
  <section
    id={anchor}
    class="block campaign-card campaign-card-{block.variant} width-{block.width}"
    class:campaign-card-closed={c.phase !== 'open'}
    aria-labelledby="{id}-title"
  >
    {#if block.variant === 'full'}
      <div class="campaign-card-inner">
        <CampaignLayout
          campaign={action}
          card={{
            title: c.title,
            lead: c.summary,
            level: depth + 1,
            href: c.href,
            image: c.image,
            sizes,
            fold: block.body && !block.body.open ? copy.read[c.kind] : null,
          }}
          {model}
          {id}
          {state}
          {preview}
          children={block.body ? text : undefined}
        />
      </div>
    {:else}
      <div class="campaign-card-inner">
        {#if c.image}
          <div class="campaign-card-image">
            <Picture image={c.image} base={model.base} {sizes} />
          </div>
        {/if}
        <div class="campaign-card-text">
          <p class="campaign-kind">
            {copy.kind[c.kind]}{c.phase === 'open' ? '' : ` · ${copy.phase[c.phase]}`}
          </p>
          <svelte:element this={headingTag(depth + 1)} id="{id}-title"
            ><a href={withBase(model.base, c.href)}>{c.title}</a></svelte:element
          >
          {#if c.summary}<p class="lead">{c.summary}</p>{/if}
          <CampaignAction campaign={action} {model} {id} level={null} />
          <div class="actions">
            <a class="button" href={withBase(model.base, c.href)}
              >{c.phase === 'open' ? copy.act[c.kind] : copy.more}</a
            >
          </div>
        </div>
      </div>
    {/if}
  </section>
{/if}
