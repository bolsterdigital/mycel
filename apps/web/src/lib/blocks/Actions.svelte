<!-- An action group (one or two links styled as buttons; navigation is never a <button>). The
     group wraps whole buttons and stacks when a row does not fit (skill ui-action-layout). -->
<script lang="ts">
  import type { RenderAction } from './model.js';
  import { withBase } from './rich-text.js';

  let { actions, base }: { actions: RenderAction[]; base: string } = $props();
</script>

{#if actions.length}
  <div class="actions">
    {#each actions as action, i (i)}
      <a class="button" class:secondary={i > 0} href={withBase(base, action.href)}>{action.label}</a
      >
    {/each}
  </div>
{/if}
