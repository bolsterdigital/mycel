<!-- The title is the single stretched link. Both archives and author profiles use this surface,
     including its decorative image, excerpt, and focus ring. The caller owns the grid and heading.
     Under the title stands one line of facts (date or the caller's own, a recording's mark and
     length, an event's place, "for members"), each a span the stylesheet separates with a dot,
     then a short excerpt. Rejected: a paragraph per fact, which made a card with three facts
     three lines taller than its neighbours, and the summary at body size, larger than the title
     on a site whose heading font runs small. -->
<script module lang="ts">
  const excerptLimit = 120;
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  /** A sentence end inside the room: `!`, `?`, or a full stop after a word of five letters or
   *  more, so "Dr.", "o.a." and "bijv." never end an excerpt. */
  const sentenceEnd = /(?:[!?]|(?<![\p{L}\p{N}.])[\p{L}\p{N}]{5,}\.)(?= )/gu;

  /**
   * The card's excerpt, in its HTML so the text wraps naturally at larger sizes: the summary when
   * it fits, else its whole sentences when they fill at least half the room, else its words up to
   * the limit and an ellipsis. The full summary still belongs to the item and the shared overview
   * read model. Rejected: clamping lines in CSS, which hides text a reader at 200% cannot reach,
   * and always cutting at the limit, which ends a card on "En…".
   */
  export function cardExcerpt(summary: string): string {
    const flat = summary.replace(/\s+/g, ' ').trim();
    if (flat.length <= excerptLimit) return flat;
    const letters = Array.from(graphemes.segment(flat), ({ segment }) => segment);
    if (letters.length <= excerptLimit) return flat;
    // One letter past the limit, so a sentence that ends exactly on it is seen.
    const room = letters.slice(0, excerptLimit + 1).join('');
    let whole = 0;
    for (const match of room.matchAll(sentenceEnd)) whole = match.index + match[0].length;
    if (whole >= excerptLimit / 2) return room.slice(0, whole);
    const head = letters.slice(0, excerptLimit - 1).join('');
    const lastSpace = head.lastIndexOf(' ');
    const excerpt =
      letters[excerptLimit - 1] === ' ' || lastSpace < 0 ? head : head.slice(0, lastSpace);
    return `${excerpt.replace(/[.,;:…]+$/, '')}…`;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HeadingTag } from './headings.js';
  import type {
    RenderImage,
    RenderCardRecording,
    CardPlaceholder as Placeholder,
  } from './model.js';
  import Picture from './Picture.svelte';
  import CardPlaceholder from './CardPlaceholder.svelte';
  let {
    title,
    href,
    base,
    image,
    sizes,
    placeholder,
    heading,
    date,
    summary,
    place,
    restrictedLabel,
    recording,
    eager = false,
    metadata,
    footer,
  }: {
    title: string;
    href: string;
    base: string;
    image: RenderImage | null;
    sizes: string;
    placeholder?: Placeholder | undefined;
    heading: HeadingTag;
    date: { iso: string; label: string };
    summary: string | null;
    place?: string | null;
    restrictedLabel?: string | null;
    recording?: RenderCardRecording | null;
    eager?: boolean;
    metadata?: Snippet;
    footer?: Snippet;
  } = $props();
</script>

<article class="campaign-card-inner overview-card">
  {#if image}
    <div class="campaign-card-image">
      <Picture {image} {base} {sizes} framed {eager} />
    </div>
  {:else if placeholder}
    <CardPlaceholder {placeholder} />
  {/if}
  <div class="campaign-card-text">
    <svelte:element this={heading} class="overview-card-title">
      <a {href}>{title}</a>
    </svelte:element>
    <p class="overview-meta">
      {#if metadata}
        {@render metadata()}
      {:else}
        <time class="overview-date" datetime={date.iso}>{date.label}</time>
      {/if}
      {#if recording}
        <!-- A Video/audio article (MY-304): the play mark is decoration, the word beside it says it. -->
        <span class="overview-recording">
          <svg class="overview-play" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M4 2.5v11l9-5.5z" />
          </svg>
          {recording.label}{#if recording.duration}{' · '}<time datetime={recording.duration.iso}
              >{recording.duration.label}</time
            >{/if}
        </span>
      {/if}
      {#if place}<span class="overview-place">{place}</span>{/if}
      {#if restrictedLabel}<span class="overview-access">{restrictedLabel}</span>{/if}
    </p>
    {#if summary}<p class="overview-excerpt">{cardExcerpt(summary)}</p>{/if}
    {@render footer?.()}
  </div>
</article>
