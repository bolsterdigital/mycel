<!-- A text block at rest (MY-110 C1, C2): a heading at the size of a heading, a text with its
     formatting, a quote with who said it, a callout in its box with its visible kind, an FAQ as the
     page lists or folds it, a CTA with what its buttons say, so a page of closed blocks reads as
     the page. No heading element (the card's own title is the outline), no link that leaves the
     unsaved form and no button that does anything: a CTA's actions are words styled like buttons;
     the one control here is an accordion's own summary, which folds the answer and never opens the
     block. The `html` comes from the escaping walk in `lib/blocks/rich-text.ts`, in its inert mode.
     The `data-rest-*` attributes are what the screen's script brings up to date when a block
     closes with typed changes. Rejected: the public block components, which print `h2` and real
     links. -->
<script lang="ts">
  type View =
    | { kind: 'heading'; text: string; from?: string }
    | {
        kind: 'quote';
        text: string;
        by: string;
        variant: string;
        variantFrom?: string;
        from?: string;
        byFrom?: readonly string[];
      }
    | { kind: 'rich-text'; html: string; proseFrom?: string }
    | {
        kind: 'callout';
        variant: string;
        variantFrom?: string;
        title: string;
        titleFrom?: string;
        html: string;
        proseFrom?: string;
      }
    | {
        kind: 'faq';
        variant: string;
        variantFrom?: string;
        title: string;
        titleFrom?: string;
        list?: string;
        locale?: string;
        entries: readonly { question: string; from?: string; html: string; proseFrom?: string }[];
      }
    | {
        kind: 'cta';
        variant: string;
        variantFrom?: string;
        title: string;
        titleFrom?: string;
        body: string;
        bodyFrom?: string;
        actions: readonly { label: string; from?: string }[];
      };

  let {
    view,
    kindLabel,
  }: {
    view: View;
    /** A callout's kind in words: its meaning is never colour alone. */
    kindLabel?: string | undefined;
  } = $props();
</script>

{#snippet answer(entry: { html: string; proseFrom?: string })}
  <div class="ui-block-text-prose" data-rest-prose={entry.proseFrom}>{@html entry.html}</div>
{/snippet}

<div class="ui-block-text">
  {#if view.kind === 'heading'}
    <p class="ui-block-text-heading" data-rest-from={view.from}>{view.text}</p>
  {:else if view.kind === 'quote'}
    <blockquote
      class="ui-block-text-quote"
      data-variant={view.variant}
      data-rest-variant={view.variantFrom}
    >
      <p data-rest-from={view.from}>{view.text}</p>
      <footer data-rest-from={view.byFrom?.join(' ')}>{view.by}</footer>
    </blockquote>
  {:else if view.kind === 'callout'}
    <div
      class="ui-block-text-callout"
      data-variant={view.variant}
      data-rest-variant={view.variantFrom}
    >
      <p class="ui-block-text-kind" data-rest-option={view.variantFrom}>{kindLabel}</p>
      <p class="ui-block-text-title" data-rest-from={view.titleFrom}>{view.title}</p>
      {@render answer(view)}
    </div>
  {:else if view.kind === 'faq'}
    <div
      class="ui-block-text-faq"
      data-rest-variant={view.variantFrom}
      data-variant={view.variant}
      data-rest-list={view.list}
      data-rest-locale={view.locale}
    >
      <p class="ui-block-text-title" data-rest-from={view.titleFrom}>{view.title}</p>
      <div data-rest-entries>
        {#each view.entries as entry, i (i)}
          {#if view.variant === 'accordion'}
            <details class="ui-block-text-entry">
              <summary><span data-rest-from={entry.from}>{entry.question}</span></summary>
              {@render answer(entry)}
            </details>
          {:else}
            <div class="ui-block-text-entry">
              <p class="ui-block-text-question" data-rest-from={entry.from}>{entry.question}</p>
              {@render answer(entry)}
            </div>
          {/if}
        {/each}
      </div>
    </div>
  {:else if view.kind === 'cta'}
    <div class="ui-block-text-cta" data-variant={view.variant} data-rest-variant={view.variantFrom}>
      <p class="ui-block-text-heading" data-rest-from={view.titleFrom}>{view.title}</p>
      <p class="ui-block-text-body" data-rest-from={view.bodyFrom}>{view.body}</p>
      <div class="ui-block-text-actions">
        {#each view.actions as action, i (i)}
          <span class="ui-block-text-action" data-rest-from={action.from}>{action.label}</span>
        {/each}
      </div>
    </div>
  {:else}
    {@render answer(view)}
  {/if}
</div>
