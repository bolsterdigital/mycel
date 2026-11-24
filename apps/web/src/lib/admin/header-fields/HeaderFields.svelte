<!-- How the document header opens (ADR 025 rule 3, amended 2026-11-23): an article chooses
     standard or cover, a page also split, whose panel can carry one button. Beside the item's own
     fields, not with the image, because the choice sets how title, lead and image open the item
     together. The button's target is the same picker as a hero's or a menu item's. -->
<script lang="ts">
  import { Field, Fieldset, Notice, Select } from '#lib/admin/ui/index.js';
  import ArticleProfileFields from './ArticleProfileFields.svelte';
  import TargetPicker from '../block-fields/TargetPicker.svelte';
  import { ui } from '../../../i18n/index.js';

  let {
    locale,
    work,
    article,
    legacy,
    v,
    items,
    choices,
    bad,
  }: {
    /** The admin's language. */
    locale: string;
    /** The content locale the form shows; the button text is per locale. */
    work: string;
    /** An article has no split header. */
    article: boolean;
    legacy: boolean;
    /** The form's value of a field, as the edit page reads it. */
    v: (name: string) => string;
    /** The newest pages and articles, the picker's list without JavaScript. */
    items: readonly { id: string; label: string }[];
    /** The picker's search route. */
    choices: string;
    /** Whether a refusal names this field. */
    bad: (name: string) => boolean;
  } = $props();
  const t = $derived(ui(locale));
  const layout = $derived(v('headerLayout') || 'standard');
</script>

{#if article}
  <ArticleProfileFields {locale} {v} {legacy} />
{/if}
{#if !article || legacy}
  <div class:legacy>
    <Select
      id="headerLayout"
      name="headerLayout"
      label={t(
        article ? 'admin.content.field.headerLayout' : 'admin.content.field.pageHeaderLayout'
      )}
      hint={t(
        article
          ? 'admin.content.field.headerLayoutHint'
          : 'admin.content.field.pageHeaderLayoutHint'
      )}
      {locale}
      value={layout}
      options={[
        { value: 'standard', label: t('admin.content.headerLayout.standard') },
        { value: 'cover', label: t('admin.content.headerLayout.cover') },
        ...(article ? [] : [{ value: 'split', label: t('admin.content.headerLayout.split') }]),
      ]}
    />
    {#if layout !== 'standard' && !v('heroImageId')}
      <Notice tone="warning" live={false}
        ><p>
          {t(
            article
              ? 'admin.content.headerLayout.noImage'
              : 'admin.content.headerLayout.noImagePage'
          )}
        </p></Notice
      >
    {/if}
  </div>
{/if}
{#if !article && layout === 'split'}
  <Fieldset legend={t('admin.content.headerAction.legend')}>
    <p class="ui-hint">{t('admin.content.headerAction.hint')}</p>
    <Field
      id="headerActionLabel.{work}"
      name="headerActionLabel.{work}"
      label="{t('admin.content.headerAction.label')} ({work})"
      {locale}
      maxlength={100}
      lang={work}
      invalid={bad('presentation.action.label')}
      value={v(`headerActionLabel.${work}`)}
    />
    <TargetPicker id="headerActionTarget" {choices} {locale} refused={bad('presentation.action')}>
      <Field
        id="headerActionTarget"
        label={t('admin.block.field.target')}
        {locale}
        invalid={bad('presentation.action')}
      >
        {#snippet control(attributes)}
          <select name="headerActionTarget" {...attributes}>
            <option value="">{t('admin.block.none')}</option>
            {#each [{ id: 'url', label: t('admin.block.target.url') }, ...items] as o (o.id)}
              <option value={o.id} selected={v('headerActionTarget') === o.id}>{o.label}</option>
            {/each}
          </select>
        {/snippet}
      </Field>
      <Field
        id="headerActionUrl"
        name="headerActionUrl"
        label={t('admin.block.field.url')}
        {locale}
        maxlength={2048}
        invalid={bad('presentation.action')}
        value={v('headerActionUrl')}
      />
    </TargetPicker>
  </Fieldset>
{/if}

<style>
  :global(.article-profile-fields:has([name='articleProfile']:checked:not([value='']))) + .legacy {
    display: none;
  }
</style>
