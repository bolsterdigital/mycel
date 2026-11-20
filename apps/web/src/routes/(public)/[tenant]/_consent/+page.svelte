<!-- The consent choice page: one checkbox per category with what this site loads under it, one
     button that saves, a link back. A native form, no JavaScript needed (ADR 009); one button, so
     no row of actions has to fit side by side. -->
<script lang="ts">
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{data.title}</title>
  <meta name="robots" content="noindex" />
  <link rel="stylesheet" href="/_site/consent.css" />
</svelte:head>

<main class="page consent-page">
  <h1>{data.title}</h1>
  <p>{data.intro}</p>
  <form method="post" action={data.action}>
    <input type="hidden" name="return" value={data.back} />
    <p>{data.necessary}</p>
    {#each data.categories as entry (entry.category)}
      <div class="consent-category">
        <input
          type="checkbox"
          id="consent-{entry.category}"
          name={entry.category}
          checked={entry.checked}
          aria-describedby="consent-{entry.category}-hint"
        />
        <label for="consent-{entry.category}">{entry.label}</label>
        <p id="consent-{entry.category}-hint">{entry.hint} {entry.loads}</p>
      </div>
    {/each}
    <p><button type="submit">{data.save}</button></p>
  </form>
  <p><a href={data.back}>{data.backLabel}</a></p>
</main>
