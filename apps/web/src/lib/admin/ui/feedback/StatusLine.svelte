<!-- One line that says how a part of the site stands when there is nothing to list (#116): "No task
     is stuck", "No mail per day yet", "Could not be read". A mark, the sentence, and on the right
     the moment it was established, in a card, so such a sentence is never loose black text under
     a heading. The tone is in the words first; the mark repeats it and differs per tone, so
     `unknown` (a question mark, dashed border) never looks like `ok` (a check) and `none` (no data
     yet, an i) never looks like either (brief admin-operations-screens § Signalen zonder
     schijnzekerheid). `role="status"`: a refresh that swaps the region announces the new line.
     Rejected: EmptyState (a title and an action for a list that can be filled; these lines have
     no action) and a Notice (a message about what just happened, not a state). -->
<script lang="ts">
  import type { When } from '../../format.js';
  import Icon from '../Icon.svelte';
  import type { IconName } from '../icons.js';

  type Tone = 'ok' | 'none' | 'unknown' | 'attention';

  let {
    text,
    tone = 'ok',
    checked,
    checkedLabel,
  }: {
    /** The state in words: "No task is stuck." */
    text: string;
    tone?: Tone;
    /** When it was established; shown on the right, muted. */
    checked?: When | undefined;
    /** The words before the moment: "Checked". */
    checkedLabel?: string | undefined;
  } = $props();

  const MARK: Record<Tone, IconName> = {
    ok: 'circle-check',
    none: 'info',
    unknown: 'circle-help',
    attention: 'triangle-alert',
  };
</script>

<div class={['ui-status-line', tone]} role="status">
  <span class="ui-status-mark"><Icon name={MARK[tone]} /></span>
  <span class="ui-status-line-text">{text}</span>
  {#if checked}
    <span class="ui-status-line-time"
      >{checkedLabel}
      <time datetime={checked.iso} title={checked.full}>{checked.text}</time></span
    >
  {/if}
</div>
