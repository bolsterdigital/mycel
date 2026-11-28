<!-- A native GET form and an ordered list of results: usable without JavaScript, announced as a
     search landmark, matches marked with <mark> from the use case's segments (no HTML from data).
     Each result is the shared article card (MY-308), its title an h2 under the page's h1; a hit
     in a recording adds "In the recording": each moment one link, its time and the line said
     there, to the item at that second. Filters (MY-308 PR 2) belong to the same GET form: the
     selects and the apply button name it with `form`, so they sit beside the results without the
     form wrapping them, and the kinds are links. Below 60rem they fold into a <details>, open
     when a filter is on; from 60rem they are a column and the summary is gone (search.css). -->
<script lang="ts">
  import { MAX_SEARCH_QUERY } from '@mycel/core';
  import ArticleCard from '#lib/blocks/ArticleCard.svelte';
  import type { SearchSegment } from '@mycel/core';
  import { ui } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const title = $derived(data.count ?? t('public.search.title'));
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
    <form id="search-form" class="search-form" method="get" action={data.action}>
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
    <div class="search-layout">
      <details class="search-filters" open={data.filtered}>
        <summary>{t('public.search.filters')}</summary>
        <div class="search-filters-body">
          <p id="search-kind" class="search-filter-label">{t('public.search.filter.kind')}</p>
          <ul class="search-kinds" aria-labelledby="search-kind">
            {#each data.kinds as kind (kind.href)}
              <li>
                <a href={kind.href} aria-current={kind.current ? 'true' : undefined}>{kind.label}</a
                >
              </li>
            {/each}
          </ul>
          {#if data.kind}<input
              type="hidden"
              name="kind"
              value={data.kind}
              form="search-form"
            />{/if}
          {#if data.sections.length}
            <label for="search-section">{t('public.search.filter.section')}</label>
            <select id="search-section" name="section" form="search-form">
              <option value="">{t('public.search.filter.section.all')}</option>
              {#each data.sections as section (section.value)}
                <option value={section.value} selected={section.selected}>{section.label}</option>
              {/each}
            </select>
          {/if}
          <label for="search-period">{t('public.search.filter.period')}</label>
          <select id="search-period" name="period" form="search-form">
            {#each data.periods as period (period.value)}
              <option value={period.value} selected={period.selected}>{period.label}</option>
            {/each}
          </select>
          <label for="search-sort">{t('public.search.sort')}</label>
          <select id="search-sort" name="sort" form="search-form">
            {#each data.sorts as sort (sort.value)}
              <option value={sort.value} selected={sort.selected}>{sort.label}</option>
            {/each}
          </select>
          <button type="submit" form="search-form">{t('public.search.apply')}</button>
        </div>
      </details>
      <div class="search-main">
        {#if data.chips.length}
          <div class="search-chips">
            <p id="search-chips">{t('public.search.chips')}</p>
            <ul aria-labelledby="search-chips">
              {#each data.chips as chip (chip.href)}
                <li><a href={chip.href}>{chip.label} <span aria-hidden="true">×</span></a></li>
              {/each}
              {#if data.clear}<li>
                  <a class="search-clear" href={data.clear}>{t('public.search.clear')}</a>
                </li>{/if}
            </ul>
          </div>
        {/if}
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
                    <time class="overview-date" datetime={result.date.iso}>{result.date.label}</time
                    >
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
        {:else if data.filtered && data.clear}
          <p class="search-empty">
            {t('public.search.noneFiltered')}
            <a href={data.clear}>{t('public.search.unfiltered')}</a>
          </p>
        {:else}
          <p class="search-empty">{t('public.search.none')}</p>
        {/if}
        {#if data.previous || data.next}<nav
            class="search-pagination"
            aria-label={t('public.search.pages')}
          >
            {#if data.previous}<a href={data.previous} rel="prev">{t('public.search.previous')}</a
              >{/if}
            {#if data.next}<a href={data.next} rel="next">{t('public.search.next')}</a>{/if}
          </nav>{/if}
      </div>
    </div>
  {/if}
</main>
