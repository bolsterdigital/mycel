<!-- "Read more" under a public article (MY-304): a section named by its heading (an h2, the
     page's h1 stays the only one), then up to three cards in the overview's card grid, the same
     card the news overview and the author profile show (ArticleCard, overview.css). No
     JavaScript. A restricted article says it is for members, as an overview card does; its link
     leads to the teaser. Rejected: a list of titles like the dossier box, which a reader arriving
     from outside passes over; a box of three is the next thing to read, so it shows the pictures. -->
<script lang="ts">
  import ArticleCard from '#lib/blocks/ArticleCard.svelte';
  import type { CardPlaceholder } from '#lib/blocks/model.js';
  import { withBase } from '#lib/blocks/rich-text.js';
  import type { RenderReadMore } from '#lib/server/public/related/read-more.js';

  let {
    more,
    base,
    placeholder,
  }: { more: RenderReadMore; base: string; placeholder?: CardPlaceholder | undefined } = $props();
</script>

<section
  class="block read-more overview overview-cards width-wide"
  aria-labelledby="read-more-title"
>
  <h2 id="read-more-title">{more.title}</h2>
  <ul class="overview-items">
    {#each more.cards as card (card.id)}
      <li class="overview-item">
        <ArticleCard
          title={card.title}
          href={withBase(base, card.href)}
          {base}
          image={card.image}
          sizes="(min-width: 48rem) 24rem, 100vw"
          {placeholder}
          heading="h3"
          date={card.date}
          summary={card.summary}
          restrictedLabel={card.restricted ? more.restricted : null}
          recording={card.recording}
        />
      </li>
    {/each}
  </ul>
</section>
