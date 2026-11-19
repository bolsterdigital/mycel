<!-- "Change address": the item's slug, folded away until a refusal names it. It carries the
     address the form was rendered with (`baseSlug`): a save changes the slug only when the field
     differs from it, so a tab left open cannot move another tab's address back. Out of the edit
     screen, which stands at its size ceiling. -->
<script lang="ts">
  import { Field } from '../ui/index.js';
  import { ui } from '../../../i18n/index.js';

  let {
    locale,
    slug,
    baseSlug,
    stored,
    flagged,
  }: {
    /** The admin's language. */
    locale: string;
    /** The field's value as posted, or empty for the stored one. */
    slug: string;
    /** The address the form was rendered with, as posted; empty for the stored one. */
    baseSlug: string;
    /** The item's stored slug. */
    stored: string;
    /** A refusal names the slug: the fold opens and the field is marked. */
    flagged: boolean;
  } = $props();
  const t = $derived(ui(locale));
</script>

<details class="ui-fold item-slug" open={flagged}>
  <summary>{t('admin.content.slug.change')}</summary>
  <input type="hidden" name="baseSlug" value={baseSlug || stored} />
  <Field
    id="slug"
    name="slug"
    label={t('admin.content.slug')}
    {locale}
    size="m"
    hint={t('admin.content.slug.editHint')}
    required
    maxlength={63}
    pattern={'[a-z0-9][a-z0-9-]{0,62}'}
    autocapitalize="off"
    spellcheck={false}
    invalid={flagged}
    value={slug || stored}
  />
</details>
