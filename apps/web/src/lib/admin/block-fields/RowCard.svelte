<!-- One card of the row editor (BlockFields): its outline is the group, so a Fieldset inside
     it (a card's button) renders flat, one outline deep, as inside a Fieldset. Rejected: a
     Fieldset per card, which would draw the card's outline twice and put its menu in a legend. -->
<script lang="ts">
  import { setContext, type Snippet } from 'svelte';
  import { GROUP } from '../ui/form/Fieldset.svelte';

  let { children }: { children: Snippet } = $props();
  setContext(GROUP, true);
</script>

<li class="ui-row-card">{@render children()}</li>
