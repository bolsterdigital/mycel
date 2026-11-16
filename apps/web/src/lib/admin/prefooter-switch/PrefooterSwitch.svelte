<!-- "No pre-footer on this page": the box that keeps the site's zone off one page or
     article. `prefooterShown` tells the save that the form showed the box, so a form without it
     keeps the stored choice (content-admin.ts). -->
<script lang="ts">
  import { Checkbox, Fieldset } from '#lib/admin/ui/index.js';
  import { ui } from '../../../i18n/index.js';

  let {
    locale,
    checked,
    collapsed,
  }: {
    /** The admin's language. */
    locale: string;
    checked: boolean;
    collapsed: boolean;
  } = $props();
  const t = $derived(ui(locale));
</script>

<Fieldset legend={t('admin.content.edit.prefooter')} {collapsed}>
  <input type="hidden" name="prefooterShown" value="1" />
  <Checkbox
    id="noPrefooter"
    name="noPrefooter"
    label={t('admin.content.field.noPrefooter')}
    hint={t('admin.content.field.noPrefooterHint')}
    {checked}
  />
</Fieldset>
