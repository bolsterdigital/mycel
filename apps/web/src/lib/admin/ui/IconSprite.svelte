<!-- Every admin icon once, as a <symbol>, rendered by the tenant layout so each Icon on the page
     can point at it with a local <use>. Hidden from assistive technology and from layout; the
     markup is the constant Lucide data of icons.ts, never input. -->
<script lang="ts">
  import { renderedHtml } from '../rendered-html.js';
  import { ICONS } from './icons.js';
</script>

<svg class="ui-icon-sprite" aria-hidden="true" focusable="false" width="0" height="0">
  {#each Object.entries(ICONS) as [name, body] (name)}
    <symbol
      id="icon-{name}"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {@html renderedHtml(body)}
    </symbol>
  {/each}
</svg>
