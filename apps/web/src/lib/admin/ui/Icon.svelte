<!-- One Lucide icon from the sprite (IconSprite, in the tenant layout). Always decoration: the
     visible label next to it names the link or button, so the icon is hidden from assistive
     technology and never the only thing that says what a control does. -->
<script lang="ts">
  import type { IconName } from './icons.js';

  let { name }: { name: IconName } = $props();
</script>

<svg class="ui-icon" aria-hidden="true" focusable="false" width="20" height="20">
  <use href="#icon-{name}" />
</svg>
