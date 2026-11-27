<!-- A native GET form and an ordered list of results: usable without JavaScript, announced as a
     search landmark, matches marked with <mark> from the use case's segments (no HTML from data).
     Each result is the shared article card (MY-308), its title an h2 under the page's h1; a hit
     in a recording adds "In the recording": each moment one link, its time and the line said
     there, to the item at that second. -->
<script lang="ts">
  import { MAX_SEARCH_QUERY } from '@mycel/core';
  import ArticleCard from '#lib/blocks/ArticleCard.svelte';
  import type { SearchSegment } from '@mycel/core';
  import { ui } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const title = $derived(
    data.q ? t('public.search.resultsFor').replace('{q}', () => data.q) : t('public.search.title')
  );
</script>

<svelte:head>
  <title>{title}</title>
  <meta name="robots" content="noindex" />
  <meta name="description" content={t('public.search.description')} />
  <link rel="canonical" href={data.canonical} />
</svelte:head>
{#snippet marked(
  segments: SearchSegment[]
)}{#each segments as segment, i (i)}{#if segment.match}<mark>{segment.text}</mark
      >{:else}{segment.text}{/if}{/each}{/snippet}
<main class="page search-page">
  <h1>{title}</h1>
  <search>
    <form class="search-form" method="get" action={data.action}>
      <label for="search-q">{t('public.search.label')}</label>
      <div class="search-row">
        <input
          id="search-q"
          name="q"
          type="search"
          value={data.q}
          maxlength={MAX_SEARCH_QUERY}
          autocomplete="off"
          enterkeyhint="search"
        />
        <button type="submit">{t('public.search.submit')}</button>
      </div>
    </form>
  </search>
  {#if data.q}
    {#if data.results.length}
      <ol class="search-results" start={data.start}>
        {#each data.results as result, n (result.id)}
          <li>
            <ArticleCard
              title={result.title}
              href={result.href}
              base={data.base}
              image={result.image}
              sizes="(min-width: 48rem) 18rem, 100vw"
              placeholder={data.placeholder}
              heading="h2"
              date={result.date}
              summary={null}
              restrictedLabel={result.restricted ? t('block.overview.restricted') : null}
              recording={result.recording}
              eager={n === 0}
              fragment={result.excerpt}
            >
              {#snippet metadata()}
                {#if result.label}<span class="overview-kind">{result.label}</span>{/if}
                <time class="overview-date" datetime={result.date.iso}>{result.date.label}</time>
              {/snippet}
              {#snippet footer()}
                {#if result.moments.length}
                  <div class="search-moments">
                    <p id="moments-{result.id}">{t('public.search.moments')}</p>
                    <ul aria-labelledby="moments-{result.id}">
                      {#each result.moments as moment (moment.href)}
                        <li>
                          <a href={moment.href}
                            ><time datetime={moment.time.iso}>{moment.time.label}</time>
                            <span>{@render marked(moment.segments)}</span></a
                          >
                        </li>
                      {/each}
                    </ul>
                  </div>
                {/if}
              {/snippet}
            </ArticleCard>
          </li>
        {/each}
      </ol>
    {:else}
      <p class="search-empty">{t('public.search.none')}</p>
    {/if}
    {#if data.previous || data.next}<nav
        class="search-pagination"
        aria-label={t('public.search.pages')}
      >
        {#if data.previous}<a href={data.previous} rel="prev">{t('public.search.previous')}</a>{/if}
        {#if data.next}<a href={data.next} rel="next">{t('public.search.next')}</a>{/if}
      </nav>{/if}
  {/if}
</main>
