<!-- Questions are h3 under the block's h2, or h2 straight under the document's h1 when the block
     has no title, so the outline never skips a level. `accordion`
     is <details>/<summary>: usable without JavaScript, keyboard and screen reader included. The
     items of one block share a `name`, so a browser that knows exclusive disclosure opens one at a
     time; any other browser simply lets several stay open.
     Rejected: a script that closes the siblings (ADR 009), which would also take the native
     keyboard and find-in-page behaviour off the table. -->
<script lang="ts">
  import { headingTag } from './headings.js';
  import type { RenderBlock, RenderModel } from './model.js';
  import RichText from './RichText.svelte';

  let {
    block,
    model,
    anchor,
    depth,
  }: {
    block: Extract<RenderBlock, { type: 'faq' }>;
    model: RenderModel;
    anchor?: string;
    depth: number;
  } = $props();

  const questionDepth = $derived(block.title ? depth + 2 : depth + 1);
  const question = $derived(headingTag(questionDepth));
</script>

<section id={anchor} class="block faq faq-{block.variant} width-{block.width}">
  {#if block.title}<svelte:element this={headingTag(depth + 1)}>{block.title}</svelte:element>{/if}
  {#each block.entries as entry, i (i)}
    {#if block.variant === 'accordion'}
      <details name="faq-{block.id}">
        <summary><svelte:element this={question}>{entry.question}</svelte:element></summary>
        <RichText
          doc={entry.answer}
          {model}
          depth={questionDepth}
          idPrefix="{block.id}-{i}"
          class="answer"
        />
      </details>
    {:else}
      <svelte:element this={question}>{entry.question}</svelte:element>
      <RichText
        doc={entry.answer}
        {model}
        depth={questionDepth}
        idPrefix="{block.id}-{i}"
        class="answer"
      />
    {/if}
  {/each}
</section>
