<!-- The title is the single stretched link. Both archives and author profiles use this surface,
     including its decorative image, excerpt, and focus ring. The caller owns the grid and heading. -->
<script module lang="ts">
  const excerptLimit = 150;
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

  // Give the card a brief excerpt in its HTML so text can wrap naturally at larger sizes.
  // The full summary still belongs to the item and the shared overview read model.
  function cardExcerpt(summary: string): string {
    const flat = summary.replace(/\s+/g, ' ').trim();
    if (flat.length <= excerptLimit) return flat;
    const letters = Array.from(graphemes.segment(flat), ({ segment }) => segment);
    if (letters.length <= excerptLimit) return flat;
    const head = letters.slice(0, excerptLimit - 1).join('');
    const lastSpace = head.lastIndexOf(' ');
    const excerpt =
      letters[excerptLimit - 1] === ' ' || lastSpace < 0 ? head : head.slice(0, lastSpace);
    return `${excerpt.replace(/[.…]+$/, '')}…`;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HeadingTag } from './headings.js';
  import type { RenderImage, CardPlaceholder as Placeholder } from './model.js';
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
    {#if metadata}
      {@render metadata()}
    {:else}
      <p class="overview-date">
        <time datetime={date.iso}>{date.label}</time>
      </p>
    {/if}
    {#if place}<p class="overview-place">{place}</p>{/if}
    {#if restrictedLabel}<p class="overview-access">{restrictedLabel}</p>{/if}
    {#if summary}<p>{cardExcerpt(summary)}</p>{/if}
    {@render footer?.()}
  </div>
</article>
