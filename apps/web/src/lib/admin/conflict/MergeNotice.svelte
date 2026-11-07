<!-- What the edit screen says after an action whose save merged with someone else's (ADR 026
     rule 4). An action that would have put the merged revision live was not taken (`held`): a
     warning that says so and asks to choose it again. Any other action: one line naming the merge
     under what the action did; a save, that it was saved with what the other saved. Rejected: a line per
     branch of the page's notice chain, which grew the page past its ceiling for one sentence. -->
<script lang="ts">
  import { fill, ui } from '../../../i18n/index.js';
  import { Notice } from '../ui/index.js';

  let {
    merge,
  }: {
    merge: {
      merged: { who: string; when: string } | null;
      held: boolean;
      saved: boolean;
      locale: string;
    };
  } = $props();
  const t = $derived(ui(merge.locale));
</script>

{#if merge.merged}
  <Notice tone={merge.held ? 'warning' : 'success'}>
    <p>
      {fill(
        t(
          merge.held
            ? 'admin.content.done.mergedHeld'
            : merge.saved
              ? 'admin.content.done.merged'
              : 'admin.content.done.mergedWith'
        ),
        merge.merged
      )}
    </p>
  </Notice>
{/if}
