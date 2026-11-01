<!-- An image block at rest (MY-110 A, the image pilot): the picture at card scale in its own
     aspect ratio, with the caption and credit the page shows under it, the way an editor
     recognises the photo. The alt text is not shown in its place: the picture says more, and
     the open editor has the field. An image that cannot be shown (gone, unreadable, without a
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
  } = $props();
</script>

<figure class="ui-block-image" data-broken={src ? undefined : ''}>
  {#if src}
    <img {src} alt="" {width} {height} loading="lazy" decoding="async" data-block-image />
  {/if}
  <div class="ui-block-image-missing" role="note">
    <p>{missing}</p>
    <a href={replace.href}>{replace.label}</a>
  </div>
  {#if caption || credit || captionSource}
    <figcaption hidden={!caption && !credit}>
      {#if captionSource}
        <span
          hidden={!caption}
          data-rest-caption={captionSource.from}
          data-rest-inherited={captionSource.inherited}>{caption ?? ''}</span
        >
      {:else if caption}<span>{caption}</span>{/if}
      {#if credit}<span class="ui-block-image-credit">{credit}</span>{/if}
    </figcaption>
  {/if}
</figure>
