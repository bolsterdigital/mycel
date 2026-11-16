<!-- The locales of an item, last in its settings: which of the site's locales the document has.
     Its own component so the edit screen stays under its line ceiling. -->
<script lang="ts">
  import { Choices, Fieldset } from '#lib/admin/ui/index.js';
  import { ui } from '../../../i18n/index.js';

  let {
    locale,
    locales,
    selected,
    invalid,
    collapsed,
  }: {
    /** The admin's language. */
    locale: string;
    /** The site's locales. */
    locales: readonly string[];
    /** The document's locales. */
    selected: readonly string[];
    invalid: boolean;
    collapsed: boolean;
  } = $props();
  const t = $derived(ui(locale));
</script>

<Fieldset legend={t('admin.content.new.locales')} {collapsed}>
  <Choices
    id="locale"
    name="locales"
    type="checkbox"
    legend={t('admin.content.new.locales')}
    {locale}
    hint={t('admin.content.edit.localesHint')}
    selected={[...selected]}
    {invalid}
    options={locales.map((l) => ({ value: l, label: l }))}
  />
</Fieldset>
