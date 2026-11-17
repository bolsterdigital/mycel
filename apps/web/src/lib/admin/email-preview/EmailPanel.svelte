<!-- An article's newsletter in the editor's side column: today one link to the e-mail
     preview of the language being edited; sending will join it here. One action, so no
     action row (skill ui-action-layout). A link, not a form control: the side column sits inside
     the editor's form, and opening the preview must not post it. -->
<script lang="ts">
  import { Button, Icon } from '#lib/admin/ui/index.js';
  import { ui } from '../../../i18n/index.js';

  let { href, locale }: { href: string; locale: string } = $props();
  const t = $derived(ui(locale));
</script>

<section aria-labelledby="email-panel-title" class="email-panel">
  <h2 id="email-panel-title">{t('admin.email.panel.title')}</h2>
  <p class="ui-hint">{t('admin.email.panel.hint')}</p>
  <Button variant="secondary" {href}><Icon name="mail" />{t('admin.email.preview')}</Button>
</section>
