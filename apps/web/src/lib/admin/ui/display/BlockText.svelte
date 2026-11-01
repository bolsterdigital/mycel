<!-- A text block at rest (MY-110 C1): a heading at the size of a heading, a text with its
     formatting, a quote with who said it, so a page of closed blocks reads as the page. No heading
     element (the card's own title is the outline) and no link that leaves the unsaved form; the
     `html` comes from the escaping walk in `lib/blocks/rich-text.ts`, in its inert mode. The
     `data-rest-*` attributes are what the screen's script brings up to date when a block closes
     with typed changes. Rejected: the public block components, which print `h2` and real links. -->
<script lang="ts">
  type View =
    | { kind: 'heading'; text: string; from?: string }
    | {
        kind: 'quote';
        text: string;
        by: string;
        variant: string;
        from?: string;
        byFrom?: readonly string[];
      }
    | { kind: 'rich-text'; html: string };

  let { view }: { view: View } = $props();
</script>

<div class="ui-block-text">
  {#if view.kind === 'heading'}
    <p class="ui-block-text-heading" data-rest-from={view.from}>{view.text}</p>
  {:else if view.kind === 'quote'}
    <blockquote class="ui-block-text-quote" data-variant={view.variant}>
      <p data-rest-from={view.from}>{view.text}</p>
      <footer data-rest-from={view.byFrom?.join(' ')}>{view.by}</footer>
    </blockquote>
  {:else}
    <div class="ui-block-text-prose" data-rest-prose>{@html view.html}</div>
  {/if}
</div>
