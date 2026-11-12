<!-- The campaign of a landing page (ADR 033) in the editor's side column: participation,
     count, goal and window, then save, open and close. The side column is inside the editor's
     form, so every control here names the separate form `campaign-form` (rendered by the item's layout,
     outside the editor's form) and posts to `campaigns/[id]` with the base it was rendered with.
     Opening and closing are their own buttons and need publishing permission (rule 10); a member
     without it sees the window as text. The buttons stand in one column (`Actions stack`): the
     side column is narrow, and long nl/en labels never share a line (skill ui-action-layout). -->
<script lang="ts">
  import { Actions, Badge, Button, Field, MetaList, Notice } from '#lib/admin/ui/index.js';
  import { fill, ui } from '../../../i18n/index.js';
  import type { UiKey } from '../../../i18n/index.js';
  import type { CampaignPanel } from '../../server/admin/campaigns.js';

  let {
    panel,
    action,
    outcome,
    locale,
    timeZone,
  }: {
    panel: CampaignPanel;
    /** Where the form posts, `/admin/<tenant>/campaigns/<id>`. */
    action: string;
    /** The outcome of the last post, as catalog copy; `refused` says how to show it. */
    outcome: { copy: UiKey; refused: boolean } | null;
    locale: string;
    /** Named under the window fields only when it differs from the site's. */
    timeZone: string | null;
  } = $props();

  const t = $derived(ui(locale));
  const f = 'campaign-form';
  const tone = { draft: 'neutral', open: 'success', closed: 'warning' } as const;
  const number = (n: number) => n.toLocaleString(locale);
  const count = $derived(
    panel.target
      ? fill(t('admin.campaign.count.ofTarget'), {
          count: number(panel.participants),
          target: number(panel.target),
        })
      : number(panel.participants)
  );
  const edits = $derived(panel.canWrite && !panel.archived);
</script>

<section id="campaign" aria-labelledby="campaign-title" class="campaign-panel">
  <h2 id="campaign-title">{t(`admin.campaign.kind.${panel.kind}`)}</h2>
  {#if outcome}
    <Notice tone={outcome.refused ? 'error' : 'success'}><p>{t(outcome.copy)}</p></Notice>
  {/if}
  <MetaList
    items={[
      {
        term: t('admin.campaign.column.state'),
        value: t(`admin.campaign.state.${panel.state}`),
      },
      { term: t('admin.campaign.column.count'), value: count },
    ]}
  />
  <p class="ui-hint">
    <Badge tone={tone[panel.state]}>{t(`admin.campaign.state.${panel.state}`)}</Badge>
    {t(panel.archived ? 'admin.campaign.archivedHint' : `admin.campaign.stateHint.${panel.state}`)}
  </p>
  {#if edits}
    <input type="hidden" form={f} name="baseUpdatedAt" value={panel.baseUpdatedAt} />
    {#if panel.canPublish}
      <Field
        id="campaign-opens"
        name="opensAt"
        form={f}
        type="datetime-local"
        label={t('admin.campaign.field.opensAt')}
        hint={timeZone ? `${t('admin.content.publication.zone')} ${timeZone}` : undefined}
        {locale}
        value={panel.opensAt}
      />
      <Field
        id="campaign-closes"
        name="closesAt"
        form={f}
        type="datetime-local"
        label={t('admin.campaign.field.closesAt')}
        hint={timeZone ? `${t('admin.content.publication.zone')} ${timeZone}` : undefined}
        {locale}
        value={panel.closesAt}
      />
    {:else}
      <MetaList
        items={[
          {
            term: t('admin.campaign.field.opensAt'),
            value: panel.opensAt.replace('T', ' ') || '–',
          },
          {
            term: t('admin.campaign.field.closesAt'),
            value: panel.closesAt.replace('T', ' ') || '–',
          },
        ]}
      />
      <p class="ui-hint">{t('admin.campaign.windowNeedsPublish')}</p>
    {/if}
    <Field
      id="campaign-target"
      name="target"
      form={f}
      type="number"
      min={1}
      step={1}
      inputmode="numeric"
      label={t('admin.campaign.field.target')}
      hint={t('admin.campaign.field.target.hint')}
      {locale}
      value={panel.target === null ? '' : String(panel.target)}
    />
    <div class="ui-choice">
      <input
        type="checkbox"
        id="campaign-counter"
        name="counterVisible"
        form={f}
        checked={panel.counterVisible}
      />
      <label for="campaign-counter">{t('admin.campaign.field.counterVisible')}</label>
    </div>
    <Actions stack>
      <Button variant="secondary" form={f} formaction="{action}?/update"
        >{t('admin.campaign.action.save')}</Button
      >
      {#if panel.canPublish && panel.state !== 'open'}
        <Button form={f} formaction="{action}?/open">{t('admin.campaign.action.open')}</Button>
      {/if}
      {#if panel.canPublish && panel.state === 'open'}
        <Button variant="secondary" form={f} formaction="{action}?/close"
          >{t('admin.campaign.action.close')}</Button
        >
      {/if}
    </Actions>
    {#if !panel.canPublish}<p class="ui-hint">{t('admin.campaign.openNeedsPublish')}</p>{/if}
  {/if}
</section>
