<!-- An item's one document header (ADR 025, brief #105): the title (the page's only h1), lead, an
     event's when and where, hero image and an article's meta line, the same markup on the public page and in both previews, so
     a preview shows what the page will. The hero is the page's first image: it loads eagerly and
     with priority. The cover is an article's option: the title in marked lines on the validated
     primary pair, never bare text on a photo, and an arrow that is a link, so it works without a
     script. The split header is a page's option (ADR 025, amended 2026-11-23): title, lead, an
     event's when and where and at most one button in a panel on the accent pair, the image beside
     it, stacked under the panel in a narrow container. Rejected: a CSS background image, which
     loses alt, srcset and the LCP hint. -->
<script lang="ts">
  import { withBase } from './rich-text.js';
  import Actions from './Actions.svelte';
  import Credit from './Credit.svelte';
  import Picture from './Picture.svelte';
  import { IMAGE_SIZES } from './sizes.js';
  import type { RenderIntro, RenderModel } from './model.js';

  let { intro, model }: { intro: RenderIntro; model: RenderModel } = $props();
</script>

{#snippet caption()}
  {#if intro.hero?.caption}<span class="caption-text">{intro.hero.caption}</span>{/if}
  {#if intro.hero?.credit}<Credit
      credit={intro.hero.credit}
      words={model.copy.credit}
      base={model.base}
    />{/if}
{/snippet}

{#snippet lead()}
  {#if intro.lead}<p class="lead">{intro.lead}</p>{/if}
{/snippet}

{#snippet event()}
  {#if intro.event}
    <dl class="page-event">
      <div>
        <dt>{intro.event.when.term}</dt>
        <dd><time datetime={intro.event.when.iso}>{intro.event.when.label}</time></dd>
      </div>
      {#if intro.event.where}
        <div>
          <dt>{intro.event.where.term}</dt>
          <dd>{intro.event.where.text}</dd>
        </div>
      {/if}
      {#if intro.event.online}
        <div>
          <dt>{intro.event.online.term}</dt>
          <dd><a href={intro.event.online.href}>{intro.event.online.text}</a></dd>
        </div>
      {/if}
    </dl>
  {/if}
{/snippet}

{#snippet meta()}
  {#if intro.article}
    <div class="page-meta article-meta" class:expanded={intro.article.portraits}>
      {#if intro.article.authors.length}
        <div class="article-authors">
          {#each intro.article.authors as author, index (index)}
            <span class="article-author">
              {#if author.image}<Picture
                  image={author.image}
                  base={model.base}
                  sizes="3rem"
                  framed
                />{/if}
              {#if author.href}<a href={withBase(model.base, author.href)}>{author.name}</a
                >{:else}<span>{author.name}</span>{/if}
            </span>
          {/each}
        </div>
      {/if}
      {#if intro.meta?.date}<time datetime={intro.meta.date.iso}>{intro.meta.date.label}</time>{/if}
      {#if intro.article.readingTime}<span>{intro.article.readingTime}</span>{/if}
      {#if intro.meta?.section}<span>{intro.meta.section}</span>{/if}
    </div>
  {:else if intro.meta}
    <p class="page-meta">
      {#if intro.meta.date}<time datetime={intro.meta.date.iso}>{intro.meta.date.label}</time
        >{/if}{#if intro.meta.byline}{#if intro.meta.date}{' · '}{/if}{intro.meta.byline &&
        !intro.meta.bylineParts
          ? intro.meta.byline
          : ''}{#if intro.meta.bylineParts}{#each intro.meta.bylineParts as part, i (i)}{#if part.href}<a
                href={part.href}>{part.text}</a
              >{:else}{part.text}{/if}{/each}{/if}{/if}{#if intro.meta.section}{#if intro.meta.date || intro.meta.byline}{' · '}{/if}{intro
          .meta.section}{/if}
    </p>
  {/if}
{/snippet}

{#if intro.header === 'cover' && intro.hero}
  <header class="page-cover">
    <Picture image={intro.hero} base={model.base} sizes="100vw" framed eager />
    <h1><span>{model.title}</span></h1>
    <a class="page-cover-arrow" href="#page-content" aria-label={model.copy.toContent}>
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
        <path
          d="M12 5v14M6 13l6 6 6-6"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </a>
  </header>
  {#if intro.hero.caption || intro.hero.credit}
    <p class="page-cover-caption">{@render caption()}</p>
  {/if}
  <div id="page-content"></div>
  {@render lead()}
  {@render event()}
  {@render meta()}
{:else if intro.header === 'split' && intro.hero}
  <header class="page-split">
    <div class="page-split-panel">
      <h1>{model.title}</h1>
      {@render lead()}
      {@render event()}
      <Actions actions={intro.action ? [intro.action] : []} base={model.base} />
    </div>
    <div class="page-split-media">
      <Picture
        image={intro.hero}
        base={model.base}
        sizes="(min-width: 56rem) 50vw, 100vw"
        framed
        eager
      />
    </div>
  </header>
  {#if intro.hero.caption || intro.hero.credit}
    <p class="page-cover-caption">{@render caption()}</p>
  {/if}
  {@render meta()}
{:else}
  <h1>{model.title}</h1>
  {@render lead()}
  {@render event()}
  {#if intro.hero}
    <figure class="block image layout-wide page-hero" class:article-compact={!!intro.article}>
      <Picture
        image={intro.hero}
        base={model.base}
        sizes={intro.article ? '(max-width: 40rem) 100vw, min(67.5dvh, 45rem)' : IMAGE_SIZES.wide}
        framed={!!intro.article}
        eager
      />
      {#if intro.hero.caption || intro.hero.credit}
        <figcaption>{@render caption()}</figcaption>
      {/if}
    </figure>
  {/if}
  {@render meta()}
  {#if !intro.hero}<hr class="page-rule" />{/if}
{/if}
