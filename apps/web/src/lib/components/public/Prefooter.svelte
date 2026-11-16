<!-- The pre-footer zone (brief prefooter): the blocks of the zone the navigation places,
     between the page and the footer. An `aside` named by the zone's title, so a screen reader
     lists it as a landmark of its own; its headings are the zone's blocks (from h2), the page's
     h1 stays the only one. It reuses the page's columns (`.page`): a wide or full block breaks out
     as it does in the body, and the distance to the content and to the footer is the zone's own
     padding, never a margin that collapses into its neighbours. -->
<script lang="ts">
  import Blocks from '#lib/blocks/Blocks.svelte';
  import type { FormState, RenderModel } from '#lib/blocks/model.js';

  let {
    zone,
    formState = null,
  }: { zone: { title: string; model: RenderModel }; formState?: FormState | null } = $props();
</script>

<aside class="page prefooter" aria-label={zone.title}>
  <Blocks model={zone.model} {formState} eagerFirstImage={false} />
</aside>
