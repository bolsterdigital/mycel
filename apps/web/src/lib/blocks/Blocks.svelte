<!-- The block list of one render model: one component per type, nothing resolved here. `paywall`
     renders nothing (the teaser boundary of #19), and a block whose reference did not resolve
     (restricted or deleted image, unknown form) renders nothing either. -->
<script lang="ts">
  import type { FormState, RenderModel } from './model.js';
  import Callout from './Callout.svelte';
  import Cta from './Cta.svelte';
  import Faq from './Faq.svelte';
  import Form from './Form.svelte';
  import Heading from './Heading.svelte';
  import Hero from './Hero.svelte';
  import Image from './Image.svelte';
  import Quote from './Quote.svelte';
  import RichText from './RichText.svelte';
  import VideoEmbed from './VideoEmbed.svelte';

  let { model, formState = null }: { model: RenderModel; formState?: FormState | null } = $props();

  // The first image of the page loads eagerly: it is likely above the fold.
  const firstImage = $derived(
    model.blocks.find((b) => (b.type === 'image' || b.type === 'hero') && b.image)?.id
  );
</script>

{#each model.blocks as block (block.id)}
  {#if block.type === 'heading'}
    <Heading text={block.text} />
  {:else if block.type === 'rich-text'}
    <RichText doc={block.doc} {model} depth={1} idPrefix={block.id} />
  {:else if block.type === 'image'}
    {#if block.image}
      <Image image={block.image} layout={block.layout} {model} eager={block.id === firstImage} />
    {/if}
  {:else if block.type === 'hero'}
    <Hero {block} {model} />
  {:else if block.type === 'cta'}
    <Cta {block} {model} />
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
      />
    {/if}
  {/if}
{/each}
