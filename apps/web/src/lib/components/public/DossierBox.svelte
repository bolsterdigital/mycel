<!-- The dossier boxes under a public item (MY-260): per dossier a section with "Part of the
     dossier", the dossier's title as a link (an h2, the page's h1 stays the only one) and its lead,
     then up to three other members as the overview's list (title and date per row, overview.css).
     No JavaScript. A section per dossier, named by its title, so a screen reader lists each one. -->
<script lang="ts">
  import { withBase } from '#lib/blocks/rich-text.js';
  import type { RenderDossiers } from '#lib/server/public/related/dossier-box.js';

  let { dossiers, base }: { dossiers: RenderDossiers; base: string } = $props();
</script>

{#each dossiers.boxes as box (box.id)}
  <section class="block dossier-box" aria-labelledby="dossier-{box.id}">
    <p class="dossier-box-kicker">{dossiers.partOf}</p>
    <h2 id="dossier-{box.id}"><a href={withBase(base, box.href)}>{box.title}</a></h2>
    {#if box.lead}<p class="dossier-box-lead">{box.lead}</p>{/if}
    {#if box.members.length}
      <div class="overview overview-list">
        <ul class="overview-items">
          {#each box.members as member (member.id)}
            <li class="overview-item">
              <a href={withBase(base, member.href)}>{member.title}</a>
              <time class="overview-date" datetime={member.date.iso}>{member.date.label}</time>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </section>
{/each}
