<!-- An action group (skill ui-action-layout): whole buttons wrap to the next line; with `stack`
     they stand in one full-width column once the group is narrower than 36rem, so a long label
     never shares a line with another action. The host is a size container, so the switch follows
     the space the group actually has, not the viewport. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    stack = false,
    end = false,
    children,
  }: { stack?: boolean; end?: boolean; children: Snippet } = $props();
</script>

<div class="ui-actions-host">
  <div class={['ui-actions', stack && 'stack', end && 'end']}>{@render children()}</div>
</div>
