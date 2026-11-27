<!-- An overview: the items the block's filter finds, read when the page is, as cards
     (image, title, date, summary) or as a list (title, date). An event's card shows when it takes
     place instead of when it was published, and where. A restricted item says it is for members,
     as text, in both layouts; its link leads to the teaser. The cards wear the campaign card's
     surface and image rules, so a site has two card styles, not three; a card without an image
     gets the site's placeholder in the same area (MY-277); overview.css lays out the
     grid and the list and gives a card its own title size and states (MY-266 PR E). Each title is
     the card's one link and names it, so the image is decorative; overview.css stretches it over
     the whole card. Rejected: the card as one link around everything, which reads the date and
     summary into the link's name.
     In a campaign index (MY-292) a card says its kind and, unless open, where participation
     stands, in place of the date, and shows the public count as the campaign card does; a
     hidden counter shows nothing. The list layout names a phase other than open after the title.
     With an archive the block ends in plain page links (`?p=2`), no JavaScript. An empty overview
     renders nothing. -->
<script lang="ts">
  import { headingTag } from './headings.js';
  import type { RenderBlock, RenderModel } from './model.js';
  import { withBase } from './rich-text.js';
  import ArticleCard from './ArticleCard.svelte';
  import CampaignCount from './CampaignCount.svelte';

  let {
    block,
    model,
    anchor,
    depth,
    eager = false,
  }: {
    block: Extract<RenderBlock, { type: 'overview' }>;
    model: RenderModel;
    anchor?: string;
    /** The heading depth the block sits under (1: under the document title); its own title is one deeper. */
    depth: number;
    eager?: boolean;
  } = $props();

  const copy = $derived(model.copy.overview);
  const campaignCopy = $derived(model.copy.campaign);
  const sizes = $derived(
    block.width === 'content'
      ? '(min-width: 48rem) 20rem, 100vw'
      : '(min-width: 48rem) 24rem, 100vw'
  );
</script>

{#if block.entries.length}
  <section id={anchor} class="block overview overview-{block.layout} width-{block.width}">
    <ul class="overview-items">
      {#each block.entries as entry, i (entry.id)}
        <li class="overview-item">
          {#if block.layout === 'cards'}
            {#snippet campaignKind()}
              {#if entry.campaign}
                {@const c = entry.campaign}
                <p class="campaign-kind">
                  {campaignCopy.kind[c.kind]}{c.phase === 'open'
                    ? ''
                    : ` · ${campaignCopy.phase[c.phase]}`}
                </p>
              {/if}
            {/snippet}
            <ArticleCard
              title={entry.title}
              href={withBase(model.base, entry.href)}
              base={model.base}
              image={entry.image}
              {sizes}
              placeholder={model.placeholder}
              heading={headingTag(depth + 1)}
              date={entry.date}
              summary={entry.summary}
              place={entry.place}
              restrictedLabel={entry.restricted ? copy.restricted : null}
              recording={entry.recording}
              eager={eager && i === 0}
              metadata={entry.campaign ? campaignKind : undefined}
            >
              {#snippet footer()}
                {#if entry.campaign}
                  <CampaignCount
                    campaign={entry.campaign}
                    {model}
                    id="{anchor ?? block.id}-{entry.id}"
                  />
                {/if}
              {/snippet}
            </ArticleCard>
          {:else}
            <a href={withBase(model.base, entry.href)}>{entry.title}</a>
            {#if entry.campaign}
              {#if entry.campaign.phase !== 'open'}<span class="overview-access"
                  >{campaignCopy.phase[entry.campaign.phase]}</span
                >{/if}
            {:else}
              <time class="overview-date" datetime={entry.date.iso}>{entry.date.label}</time>
            {/if}
            {#if entry.restricted}<span class="overview-access">{copy.restricted}</span>{/if}
          {/if}
        </li>
      {/each}
    </ul>
    {#if block.older || block.newer}
      <nav class="overview-pages" aria-label={copy.label}>
        {#if block.newer}<a href={withBase(model.base, block.newer)}>{copy.newer}</a>{/if}
        {#if block.older}<a href={withBase(model.base, block.older)}>{copy.older}</a>{/if}
      </nav>
    {/if}
  </section>
{/if}
