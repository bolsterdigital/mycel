<!-- A campaign card (ADR 033 rule 4): the campaign as its landing page shows it now, as a
     reference, never a copy. Compact is the image, kind and phase, title, summary, the count and
     one link to the landing page, which invites taking part only while participation is open. Full
     adds the campaign's form inside the card, under the count, while it is open (the resolver gives it only then); otherwise it is
     compact. The heading names the card, so the image is decorative. An unavailable campaign
     renders nothing here; Blocks.svelte shows the preview's diagnosis instead. -->
<script lang="ts">
  import { BLOCK_DEPTH, headingTag } from './headings.js';
  import type { FormState, RenderBlock, RenderModel } from './model.js';
  import { withBase } from './rich-text.js';
  import CampaignCount from './CampaignCount.svelte';
  import Form from './Form.svelte';
  import Picture from './Picture.svelte';

  let {
    block,
    model,
    state,
    preview = null,
  }: {
    block: Extract<RenderBlock, { type: 'campaign-card' }>;
    model: RenderModel;
    state: FormState | null | undefined;
    preview?: string | null;
  } = $props();

  const copy = $derived(model.copy.campaign);
  const id = $derived(`campaign-${block.id}`);
  const sizes = $derived(
    block.width === 'content'
      ? '(min-width: 48rem) 16rem, 100vw'
      : '(min-width: 48rem) 24rem, 100vw'
  );
</script>

{#if block.campaign}
  {@const c = block.campaign}
  <section
    class="block campaign-card campaign-card-{block.variant} width-{block.width}"
    class:campaign-card-closed={c.phase !== 'open'}
    aria-labelledby="{id}-title"
  >
    <div class="campaign-card-inner">
      {#if c.image}
        <div class="campaign-card-image">
          <Picture image={c.image} base={model.base} {sizes} />
        </div>
      {/if}
      <div class="campaign-card-text">
        <p class="campaign-card-kind">{copy.kind[c.kind]} · {copy.phase[c.phase]}</p>
        <svelte:element this={headingTag(BLOCK_DEPTH)} id="{id}-title">{c.title}</svelte:element>
        {#if c.summary}<p>{c.summary}</p>{/if}
        <CampaignCount campaign={c} {model} {id} />
        {#if block.form}
          <Form form={block.form} variant="default" width="content" {model} {state} {preview} />
          <p><a href={withBase(model.base, c.href)}>{copy.more}</a></p>
        {:else}
          <div class="actions">
            <a class="button" href={withBase(model.base, c.href)}
              >{c.phase === 'open' ? copy.act[c.kind] : copy.more}</a
            >
          </div>
        {/if}
      </div>
    </div>
  </section>
{/if}
