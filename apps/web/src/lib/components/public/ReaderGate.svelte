<!-- Where the body of a restricted item was left out (ADR 016 rule 3): what the rest is for and,
     for a visitor, the way to sign in; with a tier that sells a membership, first the way to
     become a member (MY-254 PR 4). The body is not on the page at all: the core cut it
     before the page was built, so this is a notice, not a cover. It borrows the card of a
     call to action; the link is navigation, so it is an `a` styled as a button. `reader-gate`
     is the element the article's structured data names as the part that is not free. -->
<script lang="ts">
  import { BLOCK_DEPTH, headingTag } from '#lib/blocks/headings.js';
  import type { PublicGate } from '#lib/server/public/public-page.js';

  let { gate }: { gate: PublicGate } = $props();
</script>

<section class="block cta cta-card width-normal align-start reader-gate">
  <svelte:element this={headingTag(BLOCK_DEPTH)}>{gate.title}</svelte:element>
  <p>{gate.body}</p>
  {#if gate.join}
    <!-- One button, to the signup page; signing in is a plain link under it, never a second
         button beside it, so nothing has to fit in a row at 320 px or 200 %. -->
    <div class="actions">
      <a class="button" href={gate.join.href}>{gate.join.label}</a>
    </div>
    {#if gate.action}
      <p><a href={gate.action.href} rel="nofollow">{gate.join.other}</a></p>
    {/if}
  {:else if gate.action}
    <div class="actions">
      <a class="button" href={gate.action.href} rel="nofollow">{gate.action.label}</a>
    </div>
  {/if}
</section>
