<!-- Profiles and article cards are ordinary links and server-rendered content, usable without JS. -->
<script lang="ts">
  import Picture from '#lib/blocks/Picture.svelte';
  import StructuredData from '#lib/components/public/StructuredData.svelte';
  import { ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
</script>

<svelte:head>
  <title>{data.head.title}</title>
  <meta name="description" content={data.head.description} />
  <link rel="canonical" href={data.head.canonical} />
  {#each data.head.alternates as alternate (alternate.hreflang)}
    <link rel="alternate" hreflang={alternate.hreflang} href={alternate.href} />
  {/each}
  <meta property="og:type" content="profile" />
  <meta property="og:locale" content={data.head.share.locale} />
  {#each data.head.share.alternates as locale (locale)}<meta
      property="og:locale:alternate"
      content={locale}
    />{/each}
  <meta property="og:title" content={data.head.title} />
  <meta property="og:description" content={data.head.description} />
  <meta property="og:url" content={data.head.canonical} />
</svelte:head>
<StructuredData value={data.head.structured} />
<main class="page person-page">
  <header class="person-header">
    {#if data.portrait}<div class="person-portrait">
        <Picture
          image={data.portrait}
          base={data.base}
          sizes="(max-width: 480px) 100vw, 240px"
          eager
        />
      </div>{/if}
    <div>
      <h1>{data.person.name}</h1>
      {#if data.person.role}<p class="lead">{data.person.role}</p>{/if}
      {#if data.person.organisation}<p>{data.person.organisation}</p>{/if}
    </div>
  </header>
  {#if data.person.bio}<p class="person-bio">{data.person.bio}</p>{/if}
  <div class="person-contact">
    {#if data.person.publicEmail}<a href={`mailto:${data.person.publicEmail}`} rel="me"
        >{data.person.publicEmail}</a
      >{/if}
    {#if data.person.phone}<a href={`tel:${data.person.phone}`} rel="me">{data.person.phone}</a
      >{/if}
    {#each data.person.links as link, i (i)}<a href={link.url} rel="me">{link.label}</a>{/each}
  </div>
  {#if data.articles.length}
    <section aria-labelledby="person-articles">
      <h2 id="person-articles">{t('public.people.articles')}</h2>
      <div class="person-articles">
        {#each data.articles as article (article.id)}
          <article>
            {#if article.image}<Picture
                image={article.image}
                base={data.base}
                sizes="(min-width: 800px) 320px, 100vw"
              />{/if}
            <h3><a href={article.href}>{article.title}</a></h3>
            <time datetime={article.publishedAt}>{article.date}</time>
            {#if article.lead}<p>{article.lead}</p>{/if}
          </article>
        {/each}
      </div>
    </section>
  {/if}
  {#if data.previous || data.next}<nav
      class="person-pagination"
      aria-label={t('public.people.articles')}
    >
      {#if data.previous}<a href={data.previous} rel="prev">{t('public.people.previous')}</a>{/if}
      {#if data.next}<a href={data.next} rel="next">{t('public.people.next')}</a>{/if}
    </nav>{/if}
</main>
