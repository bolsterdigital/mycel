<!-- The article's first HTML has the writer's geometry. Card controls are the actual native
     form nodes TipTap adopts, not copies; prose uses the existing escaping rich-text renderer.
     Rejected: independent placeholder heights, which drift with content, locale and wrapping. -->
<script lang="ts" generics="B extends { id: string; type: BlockType }">
  import type { Snippet } from 'svelte';
  import type { BlockType } from '@mycel/core';
  import { renderedHtml } from '#lib/admin/trusted/rendered-html.js';
  import { articleProseHtml, type ArticleEditorDocument } from '../article-document.js';
  let {
    blocks,
    document,
    card,
    inserter,
    label,
    native = false,
    inserting = true,
  }: {
    blocks: readonly B[];
    document: ArticleEditorDocument | null;
    card: Snippet<[B, number]>;
    inserter: Snippet<[B, number]>;
    label: (type: BlockType) => string;
    native?: boolean;
    inserting?: boolean;
  } = $props();
</script>

{#each blocks as block, i (block.id)}
  {#if native}
    {#if block.type === 'rich-text'}
      {@render inserter(block, i)}
      <fieldset class="native-block" data-native-prose>
        <legend class="ui-visually-hidden">{label(block.type)}</legend>
        {@render card(block, i)}
      </fieldset>
    {/if}
  {:else if block.type === 'rich-text'}
    {@const prose = document?.content.find((node) => node.attrs.blockId === block.id)}
    {#if prose}
      <section
        class="writing-prose-preview"
        id="block-{block.id}"
        data-mycel-prose
        data-block-id={block.id}
        data-through={prose.attrs.showThrough?.text}
        data-through-locale={prose.attrs.showThrough?.locale}
      >
        {@html renderedHtml(articleProseHtml(prose))}
      </section>
    {/if}
  {:else}
    <div class="editor-card" data-block-id={block.id} data-block-type={block.type}>
      {#if inserting}{@render inserter(block, i)}{/if}
      <fieldset class="native-block">
        <legend class="ui-visually-hidden">{label(block.type)}</legend>
        {@render card(block, i)}
      </fieldset>
    </div>
  {/if}
{/each}

<style>
  .native-block {
    border: 0;
    padding: 0;
    margin: 0;
    min-inline-size: 0;
  }
  .native-block:global([hidden]) {
    display: none;
  }
</style>
