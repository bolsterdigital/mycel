<!-- Where a button links to: with JavaScript one search field that finds pages and
     articles together or takes an address of its own (`static/_admin/target-picker.js`); without
     it, the select of the newest items plus an address field, which stay in the form and post in
     both cases. The search has no name: it writes its choice into those two controls, so the
     server reads one shape. After a refusal the script leaves the native pair on screen, where the
     error summary points. Rejected: a combobox that posts its own value (a second form shape to
     read back) and a datalist (no way to keep an item id apart from its label). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import AdminScript from '../trusted/AdminScript.svelte';
  import { Field } from '../ui/index.js';
  import { ui } from '../../../i18n/index.js';

  let {
    id,
    choices,
    locale,
    refused,
    children,
  }: {
    /** The select's id; the search, its list and its status derive theirs from it. */
    id: string;
    /** The search route, with the content locale its labels are in. */
    choices: string;
    locale: string;
    /** A refusal names the select or the address: the native pair stays. */
    refused: boolean;
    children: Snippet;
  } = $props();
  const t = $derived(ui(locale));
  const copy = $derived(
    JSON.stringify({
      address: t('admin.block.target.useAddress'),
      nothing: t('admin.block.target.nothing'),
      failed: t('admin.block.target.failed'),
      found: t('admin.block.target.found'),
    })
  );
</script>

<div
  class="ui-target"
  data-target-picker={refused ? undefined : ''}
  data-choices={choices}
  data-copy={copy}
>
  <div class="ui-target-search" data-target-search hidden>
    <Field
      id="{id}-search"
      label={t('admin.block.field.target')}
      {locale}
      hint={t('admin.block.target.hint')}
      hintInline
    >
      {#snippet control(attributes)}
        <input
          type="text"
          role="combobox"
          autocomplete="off"
          aria-autocomplete="list"
          aria-expanded="false"
          aria-controls="{id}-options"
          {...attributes}
        />
      {/snippet}
    </Field>
    <ul
      class="ui-target-options"
      id="{id}-options"
      role="listbox"
      aria-label={t('admin.block.field.target')}
      hidden
    ></ul>
    <p class="ui-hint" role="status" data-target-status></p>
  </div>
  <div data-target-native>{@render children()}</div>
</div>
<AdminScript src="/_admin/target-picker.js" />
