<!-- A native GET form and an ordered list of links: usable without JavaScript, announced as a
     search landmark, matches marked with <mark> from the use case's segments (no HTML from data). -->
<script lang="ts">
  import { MAX_SEARCH_QUERY } from '@mycel/core';
  import { ui } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const title = $derived(
    data.q ? t('public.search.resultsFor').replace('{q}', data.q) : t('public.search.title')
  );
</script>

<svelte:head>
  <title>{title}</title>
  <meta name="robots" content="noindex" />
  <meta name="description" content={t('public.search.description')} />
  <link rel="canonical" href={data.canonical} />
</svelte:head>
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
        {#each data.results as result (result.id)}
          <li>
            <h2><a href={result.href}>{result.title}</a></h2>
            {#if result.excerpt.length}<p>
                {#each result.excerpt as segment, i (i)}{#if segment.match}<mark
                      >{segment.text}</mark
                    >{:else}{segment.text}{/if}{/each}
              </p>{/if}
            <time datetime={result.publishedAt}>{result.date}</time>
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
