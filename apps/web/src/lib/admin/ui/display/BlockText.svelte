<!-- A text block at rest (MY-110 C1, C2): a heading at the size of a heading, a text with its
     formatting, a quote with who said it, a callout in its box with its visible kind, an FAQ as the
     page lists or folds it, a CTA with what its buttons say, so a page of closed blocks reads as
     the page. No heading element (the card's own title is the outline), no link that leaves the
     unsaved form and no button that does anything: a CTA's actions are words styled like buttons;
     the one control here is an accordion's own summary, which folds the answer and never opens the
     block. A video is its title and host, with no player, poster or request to the host (ADR 009;
     external images fall outside img-src 'self'). A form is the shape of its definition in spans:
     no form, input or button exists here, so nothing can be submitted. A paywall is a line that
     says what the boundary does, and only here: the public page renders nothing for it. The `html` comes from the escaping walk in `lib/blocks/rich-text.ts`, in its inert mode.
     The `data-rest-*` attributes are what the screen's script brings up to date when a block
     closes with typed changes. Rejected: the public block components, which print `h2` and real
     links. -->
<script lang="ts">
  import { renderedHtml } from '../../rendered-html.js';
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
      }
    | { kind: 'paywall' }
    | {
        kind: 'video';
        provider: string;
        providerFrom?: string;
        title: string;
        titleFrom?: string;
        caption: string;
        captionFrom?: string;
      }
    | {
        kind: 'form';
        variant: string;
        variantFrom?: string;
        idFrom?: string;
        unread?: true;
        form: {
          list: string;
          fields: readonly { type: 'email' | 'consent'; label: string }[];
          submit: string;
        } | null;
      };

  let {
    view,
    kindLabel,
    noteLabel,
  }: {
    view: View;
    /** A callout's kind, a video's host, what a form is or what a paywall does, in words. */
    kindLabel?: string | undefined;
    /**
     * A form: shown once its reference was edited, as the screen cannot look it up before the save.
     * A paywall: what the boundary does on this page now, when that differs from the rule.
     */
    noteLabel?: string | undefined;
  } = $props();
</script>

{#snippet answer(entry: { html: string; proseFrom?: string })}
  <div class="ui-block-text-prose" data-rest-prose={entry.proseFrom}>
    {@html renderedHtml(entry.html)}
  </div>
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
  {:else if view.kind === 'paywall'}
    <div class="ui-block-text-boundary">
      <p class="ui-block-text-kind">{kindLabel}</p>
      {#if noteLabel}<p class="ui-block-text-changed">{noteLabel}</p>{/if}
    </div>
  {:else if view.kind === 'video'}
    <div class="ui-block-text-video">
      <span class="ui-block-text-play"></span>
      <div>
        <p class="ui-block-text-title" data-rest-from={view.titleFrom}>{view.title}</p>
        <p class="ui-block-text-kind" data-rest-option={view.providerFrom}>{kindLabel}</p>
        <p class="ui-block-text-body" data-rest-from={view.captionFrom}>{view.caption}</p>
      </div>
    </div>
  {:else if view.kind === 'form'}
    <div
      class="ui-block-text-form"
      data-variant={view.variant}
      data-rest-variant={view.variantFrom}
    >
      <p class="ui-block-text-kind" data-missing={view.form || view.unread ? undefined : ''}>
        {kindLabel}
      </p>
      {#if view.form}
        {#each view.form.fields as field, i (i)}
          {#if field.type === 'email'}
            <p class="ui-block-text-field">{field.label}</p>
            <span class="ui-block-text-input"></span>
          {:else}
            <p class="ui-block-text-consent">
              <span class="ui-block-text-check"></span>{field.label}
            </p>
          {/if}
        {/each}
        <div class="ui-block-text-actions">
          <span class="ui-block-text-action">{view.form.submit}</span>
        </div>
      {/if}
      <p class="ui-block-text-changed" data-rest-changed={view.idFrom} hidden>{noteLabel}</p>
    </div>
  {:else}
    {@render answer(view)}
  {/if}
</div>
