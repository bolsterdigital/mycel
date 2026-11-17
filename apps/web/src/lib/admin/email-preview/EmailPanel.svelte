<!-- An article's newsletter in the editor's side column (ADR 010, ADR 018 rule 4): what it was sent as, the
     settings (on or off, list, subject in the language being edited), then preview, test and send.
     The settings are fields of the editor's form and go with Save, so publishing carries them;
     what a send makes is always the published version (core reads it, the panel only says what
     core would answer). Test is a button of the separate form `newsletter-form` (rendered by the
     item's layout, outside the editor's form); sending goes to a page of its own that names list,
     count and languages before anything goes out, so it needs no JavaScript and no dialog.
     Without `mailing:send` the settings show and the two send actions do not. The actions stand
     in one column (`Actions stack`): the side column is narrow and the nl/en labels are long
     (skill ui-action-layout). The preview is a link, not a form control: opening it must not post
     the editor's form. -->
<script lang="ts">
  import { Actions, Button, Checkbox, Field, Icon, Notice, Select } from '#lib/admin/ui/index.js';
  import { plural, ui, type UiKey } from '../../../i18n/index.js';
  import type { NewsletterPanel } from '../../server/mail/newsletter.js';

  let {
    panel,
    work,
    outcome,
    locale,
    values,
    canWrite,
  }: {
    panel: NewsletterPanel;
    /** The language the editor works in: the subject field and the test are for it. */
    work: string;
    outcome: { copy: UiKey; ok: boolean } | null;
    locale: string;
    /** The editor form's values (posted ones after a failed save). */
    values: Record<string, string | string[]>;
    canWrite: boolean;
  } = $props();

  const t = $derived(ui(locale));
  const v = (k: string) => {
    const x = values[k];
    return typeof x === 'string' ? x : '';
  };
  const subject = $derived(`emailSubject.${work}`);
  const send = $derived(panel.send);
</script>

<section aria-labelledby="email-panel-title" class="email-panel">
  <h2 id="email-panel-title">{t('admin.email.panel.title')}</h2>
  {#if outcome}
    <Notice tone={outcome.ok ? 'success' : 'error'}><p>{t(outcome.copy)}</p></Notice>
  {/if}
  {#if panel.editions.length}
    <ul class="email-sent">
      {#each panel.editions as edition (edition.href)}
        <li>
          <span>
            {plural(t, 'admin.email.sent', edition.recipients, { at: edition.at })}
            {#if edition.delivering}{t('admin.email.sent.delivering')}{/if}
          </span>
          <a href={edition.href}>{t('admin.email.sent.view')}</a>
        </li>
      {/each}
    </ul>
  {/if}
  <p class="ui-hint">{t('admin.email.panel.hint')}</p>
  {#if canWrite}
    <input type="hidden" name="emailShown" value="1" />
    {#if panel.lists.length}
      <Checkbox
        id="emailOn"
        name="emailOn"
        label={t('admin.email.field.on')}
        checked={v('emailOn') === 'on'}
      />
      <Select
        id="emailList"
        name="emailList"
        label={t('admin.email.field.list')}
        {locale}
        options={panel.lists.map((l) => ({ value: l.id, label: l.label }))}
        value={v('emailList')}
      />
      <Field
        id={subject}
        name={subject}
        label={t('admin.email.field.subject')}
        hint={t('admin.email.field.subject.hint')}
        hintInline
        {locale}
        maxlength={200}
        value={v(subject) || v(`title.${work}`)}
      />
    {:else}
      <p class="ui-hint">{t('admin.email.noLists')}</p>
    {/if}
  {/if}
  {#if panel.canSend && panel.blocked}<p class="ui-hint">{t(panel.blocked)}</p>{/if}
  <Actions stack>
    <Button variant="secondary" href={panel.previewHref}
      ><Icon name="mail" />{t('admin.email.preview')}</Button
    >
    {#if panel.canSend && send.ok}
      <Button
        variant="secondary"
        form="newsletter-form"
        formaction="{panel.sendHref}?/test&locale={encodeURIComponent(work)}"
        >{t('admin.email.test')}</Button
      >
      <Button href="{panel.sendHref}?locale={encodeURIComponent(work)}"
        >{plural(t, 'admin.email.send', send.recipients)}</Button
      >
    {/if}
  </Actions>
</section>

<style>
  .email-sent {
    display: grid;
    gap: 0.75rem;
    margin: 0 0 1rem;
    padding: 0;
    list-style: none;
  }
  .email-sent li {
    display: grid;
    gap: 0.25rem;
  }
</style>
