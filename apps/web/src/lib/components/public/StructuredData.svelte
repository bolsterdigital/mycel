<!-- The serializer escapes closing script tags; this is an inert data block, without a client bundle. -->
<script lang="ts">
  import { jsonLd } from '#lib/public/structured-data.js';
  let { value }: { value: unknown } = $props();
</script>

<svelte:head>{@html `<script type="application/ld+json">${jsonLd(value)}</script>`}</svelte:head>
