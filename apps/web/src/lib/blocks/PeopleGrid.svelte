<!-- Team members exist without profile pages. Only the resolved name link navigates; contact
     links remain separate native controls, rather than nesting them in a clickable card. -->
<script lang="ts">
  import type { RenderBlock, RenderModel } from './model.js';
  import { BLOCK_DEPTH, headingTag } from './headings.js';
  import { withBase } from './rich-text.js';
  import Picture from './Picture.svelte';
  let {
    block,
    model,
    eager = false,
  }: {
    block: Extract<RenderBlock, { type: 'people-grid' }>;
    model: RenderModel;
    eager?: boolean;
  } = $props();
  const firstImageId = $derived(block.people.find((p) => p.image)?.id);
  const sizes = $derived(
    `(min-width: 64rem) ${block.columns === '2' ? '33rem' : block.columns === '3' ? '21.3rem' : '15.5rem'}, (min-width: 40rem) calc((100vw - 4rem) / 2), calc(100vw - 2rem)`
  );
</script>

{#if block.people.length}
  <div class="block width-wide people-grid people-grid-{block.columns}">
    {#each block.people as person (person.id)}
      <article class="person-card">
        {#if person.image}
          <Picture
            image={person.image}
            base={model.base}
            {sizes}
            eager={eager && person.id === firstImageId}
          />
        {/if}
        <svelte:element this={headingTag(BLOCK_DEPTH)}>
          {#if person.href}<a href={withBase(model.base, person.href)}>{person.name}</a
            >{:else}{person.name}{/if}
        </svelte:element>
        {#if block.showRole && person.role}<p>{person.role}</p>{/if}
        {#if block.showBio && person.bio}<p>{person.bio}</p>{/if}
        {#if block.showContact}
          <div class="person-contact">
            {#if person.publicEmail}<a href="mailto:{person.publicEmail}" rel="me"
                >{person.publicEmail}</a
              >{/if}
            {#if person.phone}<a href="tel:{person.phone}" rel="me">{person.phone}</a>{/if}
            {#each person.links as link}<a href={link.url} rel="me">{link.label}</a>{/each}
          </div>
        {/if}
      </article>
    {/each}
  </div>
{/if}
