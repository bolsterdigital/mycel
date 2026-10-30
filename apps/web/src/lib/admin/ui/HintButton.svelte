<!-- The ⓘ beside a label that opens the control's hint (#87, editor trial 4b-2: "after reading it
     once it is clutter, but whoever does not know it must find it"). A native popover opened by
     `popovertarget`, so it works without JavaScript, closes on Escape or a click elsewhere, and
     the browser sets aria-expanded. The hint element itself stays the control's description
     (aria-describedby reaches a closed popover too), so a screen reader hears it as before; the
     button only shows it. Rejected: a hover tooltip (unreachable by keyboard and touch) and a
     <details> (pushes the field down every time it opens). -->
<script lang="ts">
  import { ui } from '../../../i18n/index.js';
  import Icon from './Icon.svelte';

  let {
    target,
    labelId,
    locale,
  }: {
    /** The id of the hint element, which carries the `popover` attribute. */
    target: string;
    /** The id of the label (or legend text) of the control the hint is about. */
    labelId: string;
    locale: string;
  } = $props();

  const t = $derived(ui(locale));
</script>

<!-- A short name ("Help") with the field's label as its description: a name holding the label
     would make the button a second match for it (a test's getByLabel, voice control "click
     Slug"), and hidden name text inside a legend would count as the legend's own text. -->
<button
  type="button"
  class="ui-hint-toggle"
  popovertarget={target}
  aria-label={t('admin.ui.hint')}
  aria-describedby={labelId}><Icon name="info" /></button
>
