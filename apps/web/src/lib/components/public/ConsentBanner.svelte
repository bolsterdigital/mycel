<!-- The consent banner of a page that places a tag manager (docs/reference/integrations.md
     § Consent). It is in the HTML hidden, so the page stays cacheable and a visitor without
     JavaScript, for whom nothing loads, sees none; `static/_site/consent.js` shows it while there is
     no choice yet. Its two buttons post to the choice page, which also works without the script;
     the script answers the post in the page instead. It sits in the flow above the content, so it
     covers nothing at any zoom and comes early in the tab order. Rejected: a fixed bar over the page,
     which hides what is under it and a focused control at 200 % zoom. -->
<script lang="ts">
  import type { ConsentModel } from '#lib/server/public/scripts/integrations.js';

  let { consent }: { consent: ConsentModel } = $props();
</script>

<section class="consent-banner" aria-labelledby="consent-title" hidden>
  <h2 id="consent-title">{consent.copy.title}</h2>
  <p>{consent.copy.body}</p>
  <form method="post" action={consent.action} class="consent-actions">
    <input type="hidden" name="return" value={consent.back} />
    <button type="submit" name="choice" value="all">{consent.copy.accept}</button>
    <button type="submit" name="choice" value="necessary">{consent.copy.necessary}</button>
    <a href={consent.choiceHref}>{consent.copy.choose}</a>
  </form>
</section>
