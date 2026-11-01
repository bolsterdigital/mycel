<!-- A progressive-enhancement script of the admin. A server-rendered page runs the tag, also without
     a client bundle. But a hydrated page can mount a component or a whole route later (the writer's
     image card, a client-side navigation away from the editor), and Svelte then copies a script
     from its template with `setAttribute('src')`, which Trusted Types refuse (vite.config.ts). So
     the tag is text that Svelte never copies, and a later mount imports the same address. The
     browser runs a module once; a `classic` script must guard itself against the second run.
     Rejected: a Trusted Types policy for script URLs, one more thing that can turn a string into
     code, for a path that needs none. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { renderedHtml } from './rendered-html.js';

  let { src, classic = false }: { src: `/_admin/${string}.js`; classic?: boolean } = $props();

  onMount(() => {
    void import(/* @vite-ignore */ src);
  });
</script>

{@html renderedHtml(`<script${classic ? '' : ' type="module"'} src="${src}"></` + `script>`)}
