<!-- One native block chooser at every insertion point. Grid is only its visual layout: each
     named button submits the closed type and existing placement through the document form.
     Search is an optional enhancement; without JavaScript every choice remains available.
     Rejected: an ARIA grid, a select beside a second action, and a separate catalogue per place. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { enhanceBlockPickers } from './block-inserter.js';
  import Icon from '../Icon.svelte';
  import type { IconName } from '../icons.js';
  import { ui } from '../../../../i18n/index.js';

  let {
    id,
    place,
    label,
    locale,
    options,
    action = '?/insert',
  }: {
    id: string;
    /** The existing placement, `end` or `before:<block id>`. */
    place: string;
    label: string;
    locale: string;
    options: readonly { value: string; label: string; icon: IconName }[];
    action?: string;
  } = $props();
  const t = $derived(ui(locale));
  onMount(enhanceBlockPickers);
</script>

<div class="ui-block-picker" data-block-picker>
  <div class="ui-field" data-type-search data-none={t('admin.block.insert.none')} hidden>
    <label for="insert-search-{id}">{t('admin.block.insert.search')}</label>
    <input id="insert-search-{id}" type="search" autocomplete="off" />
    <p class="ui-hint" role="status" data-type-count hidden></p>
  </div>
  <p class="ui-block-picker-place" id="insert-place-{id}">{label}</p>
  <div class="ui-block-picker-grid">
    {#each options as option (option.value)}
      <button
        class="ui-block-picker-option"
        type="submit"
        formaction={action}
        name="insert"
        value="{option.value}|{place}"
        aria-describedby="insert-place-{id}"
        data-block-type={option.value}
        ><Icon name={option.icon} /><span>{option.label}</span></button
      >
    {/each}
  </div>
</div>
