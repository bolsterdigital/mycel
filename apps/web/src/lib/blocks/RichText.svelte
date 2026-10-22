<!-- Rich text as escaped HTML from rich-text.ts (one walk for headings, links and footnotes). -->
<script lang="ts">
  import type { RichTextDoc } from '@mycel/core';
  import type { RenderModel } from './model.js';
  import { richTextHtml } from './rich-text.js';

  let {
    doc,
    model,
    depth,
    idPrefix,
    class: className = 'block rich-text',
  }: {
    doc: RichTextDoc;
    model: RenderModel;
    /** The heading depth the text sits under (1: straight under the document title). */
    depth: number;
    idPrefix: string;
    class?: string;
  } = $props();

  const html = $derived(
    richTextHtml(doc, {
      depth,
      links: model.links,
      base: model.base,
      idPrefix,
      footnotes: model.copy.footnotes,
      footnoteBack: model.copy.footnoteBack,
    })
  );
</script>

<div class={className}>{@html html}</div>
