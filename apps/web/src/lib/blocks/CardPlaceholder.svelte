<!-- The image area of a card whose item has no image along its chain, not even the site's default
     (MY-277): the primary pair with the site's logo, or the first letter of its name, centred in
     the same 3:2 area, so a row of cards keeps one rhythm. Decorative: hidden from the
     accessibility tree, the card's title names it. Rejected: an empty area (a gap that reads as a
     broken image) and a stock image (a visitor reads it as content). -->
<script lang="ts">
  import type { CardPlaceholder } from './model.js';

  let { placeholder }: { placeholder: CardPlaceholder } = $props();
</script>

<div class="campaign-card-image card-placeholder" aria-hidden="true">
  {#if placeholder.logo}<img
      src={placeholder.logo.src}
      width={placeholder.logo.width}
      height={placeholder.logo.height}
      alt=""
      loading="lazy"
    />{:else}<span>{placeholder.initial}</span>{/if}
</div>
