<!-- The block list of one render model: one component per type, nothing resolved here. `paywall`
     renders nothing (the teaser boundary of #19), and a block whose reference did not resolve
     (restricted or deleted image, unknown form) renders nothing either. `preview` is the admin
     preview's note for forms (#11), which then do not post; `campaignNotes` are the preview's words
     for a campaign card: that it is a live reference, or why it shows nothing (ADR 033 rule 4). -->
<script lang="ts">
  import type { FormState, RenderBlock, RenderModel } from './model.js';
  import Callout from './Callout.svelte';
  import CampaignCard from './CampaignCard.svelte';
  import CampaignNotice from './CampaignNotice.svelte';
  import Cards from './Cards.svelte';
  import PeopleGrid from './PeopleGrid.svelte';
  import Cta from './Cta.svelte';
  import Faq from './Faq.svelte';
  import FileDownload from './FileDownload.svelte';
  import Audio from './Audio.svelte';
  import Form from './Form.svelte';
  import Gallery from './Gallery.svelte';
  import Heading from './Heading.svelte';
  import Timeline from './Timeline.svelte';
  import Hero from './Hero.svelte';
  import Image from './Image.svelte';
  import Quote from './Quote.svelte';
  import RichText from './RichText.svelte';
  import VideoEmbed from './VideoEmbed.svelte';

  let {
    model,
    formState = null,
    preview = null,
    selectable = false,
    eagerFirstImage = true,
    campaignNotes = null,
  }: {
    model: RenderModel;
    formState?: FormState | null;
    preview?: string | null;
    campaignNotes?: { live: string; reasons: Record<string, string> } | null;
    selectable?: boolean;
    /** False when the page shows a hero image above the blocks, which is then the eager one. */
    eagerFirstImage?: boolean;
  } = $props();

  // The first image of the page loads eagerly: it is likely above the fold.
  const firstImage = $derived(
    eagerFirstImage
      ? model.blocks.find(
          (b) =>
            ((b.type === 'image' || b.type === 'hero') && b.image) ||
            (b.type === 'people-grid' && b.people.some((p) => p.image))
        )?.id
      : undefined
  );
</script>

{#snippet rendered(block: RenderBlock)}
  {#if block.type === 'heading'}
    <Heading text={block.text} />
  {:else if block.type === 'rich-text'}
    <RichText
      doc={block.doc}
      {model}
      depth={1}
      idPrefix={block.id}
      class={block.sourceId ? 'block rich-text rich-text-opening' : 'block rich-text'}
    />
  {:else if block.type === 'image'}
    {#if block.image}
      <Image image={block.image} layout={block.layout} {model} eager={block.id === firstImage} />
    {/if}
  {:else if block.type === 'hero'}
    <Hero {block} {model} />
  {:else if block.type === 'cta'}
    <Cta {block} {model} />
  {:else if block.type === 'people-grid'}
    <PeopleGrid {block} {model} eager={block.id === firstImage} />
  {:else if block.type === 'cards'}
    <Cards {block} {model} />
  {:else if block.type === 'file-download'}
    <FileDownload {block} {model} />
  {:else if block.type === 'gallery'}
    <Gallery {block} {model} />
  {:else if block.type === 'audio'}
    <Audio {block} {model} />
  {:else if block.type === 'timeline'}
    <Timeline {block} {model} />
  {:else if block.type === 'callout'}
    <Callout {block} {model} />
  {:else if block.type === 'faq'}
    <Faq {block} {model} />
  {:else if block.type === 'quote'}
    <Quote {block} />
  {:else if block.type === 'video-embed'}
    <VideoEmbed {block} {model} />
  {:else if block.type === 'form'}
    {#if block.form}
      <Form
        form={block.form}
        variant={block.variant}
        width={block.width}
        {model}
        state={formState}
        {preview}
      />
    {:else if block.campaign}
      <CampaignNotice
        campaign={block.campaign}
        {model}
        id={block.id}
        variant={block.variant}
        width={block.width}
      />
    {/if}
  {:else if block.type === 'campaign-card'}
    {#if campaignNotes}
      <p class="block preview-note" class:preview-note-warning={!block.campaign}>
        {block.campaign ? campaignNotes.live : campaignNotes.reasons[block.diagnosis ?? 'unknown']}
      </p>
    {/if}
    <CampaignCard {block} {model} state={formState} {preview} />
  {/if}
{/snippet}

{#each model.blocks as block (block.id)}
  {#if selectable}
    <div
      data-block-id={(block.type === 'rich-text' && block.sourceId) || block.id}
      class="preview-selectable"
    >
      {@render rendered(block)}
    </div>
  {:else}
    {@render rendered(block)}
  {/if}
{/each}
