<!-- A native author choice with inline creation; it posts the surrounding article without saving it. -->
<script lang="ts">
  import { Choices, Field, Button } from '../ui/index.js';
  import { fill, ui } from '../../../i18n/index.js';
  import { shortId, withAbsent } from './absent.js';
  let {
    locale,
    authors,
    selected,
    write,
    name,
    slug,
    action,
  }: {
    locale: string;
    authors: readonly { id: string; name: string; absent?: boolean }[];
    selected: readonly string[];
    write: boolean;
    name: string;
    slug: string;
    action: string;
  } = $props();
  const t = $derived(ui(locale));
  /** An erased person's id still on the article (ADR 034): shown checked, removable by unchecking. */
  const absentLabel = (id: string) => fill(t('admin.people.absent'), { id: shortId(id) });
</script>

<div id="authors">
  <Choices
    id="author"
    name="authorIds"
    type="checkbox"
    searchable
    legend={t('admin.content.field.authors')}
    {locale}
    hint={authors.length === 0 ? t('admin.content.edit.noAuthors') : undefined}
    {selected}
    options={withAbsent(
      authors.map((a) => ({ value: a.id, label: a.absent ? absentLabel(a.id) : a.name })),
      (o) => o.value,
      selected,
      (id) => ({ value: id, label: absentLabel(id) })
    )}
  />
  {#if write}<details class="ui-fold">
      <summary>{t('admin.people.new')}</summary>
      <Field
        id="new-author-name"
        name="newAuthorName"
        label={t('admin.people.name')}
        {locale}
        value={name}
        maxlength={200}
      />
      <Field
        id="new-author-slug"
        name="newAuthorSlug"
        label={t('admin.people.slug')}
        hint={t('admin.people.slugHint')}
        {locale}
        value={slug}
        maxlength={63}
      />
      <Button formaction={action} formnovalidate>{t('admin.people.quick')}</Button>
    </details>{/if}
</div>
