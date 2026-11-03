<!-- An image block at rest: a compact thumbnail beside the complete caption, alt/decorative
     state and credit. A native disclosure offers the larger image in its own ratio only when
     requested; long words stay available rather than being clipped to the thumbnail's height.
     An image that cannot be shown (gone, unreadable, without a
     variant, or failing to load: the screen's script flips `data-broken`) says which file is
     missing and offers "Replace", which opens the block's media field; the stored reference stays
     until the editor picks another. The caption stays in the markup while it is empty, because
     the screen's script sets it at close by the field's mode, as a save would. Rejected: a placeholder that looks like a working image, and
     the filename or id in place of the picture. -->
<script lang="ts">
  let {
    src,
    width,
    height,
    caption,
    captionSource = null,
    credit,
    missing,
    replace,
    thumbSrc,
    previewLabel,
    alt,
  }: {
    /** The variant URL, or null when there is nothing to show. */
    src: string | null;
    width: number;
    height: number;
    /** The caption the page shows in this locale (the block's own, else the file's), or null. */
    caption: string | null;
    /** Where the script reads the caption from; null when it does not follow (a legacy hero). */
    captionSource?: { from: string; inherited: string } | null;
    /** The credit line as the page words it, or null. */
    credit: string | null;
    /** What the card says when the image cannot be shown: "Image not available: <file>". */
    missing: string;
    /** "Replace": a link to the block's media field. */
    replace: { href: string; label: string };
    thumbSrc?: string | undefined;
    previewLabel?: string | undefined;
    alt?:
      | {
          text: string;
          decorative: boolean;
          from: string;
          decorativeFrom: string;
          label: string;
          decorativeLabel: string;
          missingLabel: string;
        }
      | undefined;
  } = $props();
</script>

<figure class="ui-block-image" data-broken={src ? undefined : ''}>
  {#if src}
    <img
      src={thumbSrc ?? src}
      alt=""
      {width}
      {height}
      loading="lazy"
      decoding="async"
      data-block-image
    />
  {/if}
  <div class="ui-block-image-missing" role="note">
    <p>{missing}</p>
    <a href={replace.href}>{replace.label}</a>
  </div>
  {#if caption || credit || captionSource || alt || previewLabel}
    <figcaption hidden={!caption && !credit && !alt && !previewLabel}>
      {#if captionSource}
        <span
          hidden={!caption}
          data-rest-caption={captionSource.from}
          data-rest-inherited={captionSource.inherited}>{caption ?? ''}</span
        >
      {:else if caption}<span>{caption}</span>{/if}
      {#if credit}<span class="ui-block-image-credit">{credit}</span>{/if}
      {#if alt}
        <div
          class="ui-block-image-alt"
          data-rest-alt={alt.from}
          data-rest-decorative={alt.decorativeFrom}
        >
          <strong>{alt.label}</strong>
          <span data-rest-alt-text hidden={alt.decorative || !alt.text.trim()}>{alt.text}</span>
          <span data-rest-alt-decorative hidden={!alt.decorative}>{alt.decorativeLabel}</span>
          <span data-rest-alt-missing hidden={alt.decorative || !!alt.text.trim()}
            >{alt.missingLabel}</span
          >
        </div>
      {/if}
      {#if previewLabel && src}
        <details class="ui-block-image-preview">
          <summary>{previewLabel}</summary>
          <img {src} alt="" {width} {height} loading="lazy" decoding="async" />
        </details>
      {/if}
    </figcaption>
  {/if}
</figure>
