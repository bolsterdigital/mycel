<!-- An offer for publication on one locale of the edit page: what stands, with the writer's note,
     and for a writer who cannot publish the note field that goes with "Offer for
     publication". The buttons stay in the status card's own action row (StatusCard), so the offer
     follows the same layout rule as publishing. The note is posted with the page's one form, as
     `reviewNote.<locale>`. Rejected: the note in a fold beside the button, which hides the one
     thing a publisher reads first. -->
<script lang="ts">
  import { fill, ui } from '../../i18n/index.js';
  import { Field, Notice } from './ui/index.js';
  import { REVIEW_NOTE_MAX } from '@mycel/core';

  let {
    locale,
    target,
    review,
    offerable,
  }: {
    /** The admin's language. */
    locale: string;
    /** The locale of the item this card is about. */
    target: string;
    review: { at: string; note: string | null } | null;
    /** The member may offer this locale now: it shows the hint and the note field. */
    offerable: boolean;
  } = $props();

  const t = $derived(ui(locale));
</script>

{#if review}
  <Notice tone="info" live={false}>
    <p>{fill(t('admin.content.review.offered'), { at: review.at })}</p>
    {#if review.note}<p>{t('admin.content.review.offeredNote')} {review.note}</p>{/if}
  </Notice>
{/if}
{#if offerable}
  <p class="ui-hint">{t('admin.content.review.hint')}</p>
  <Field
    id="reviewNote.{target}"
    label={t('admin.content.review.note')}
    hint={t('admin.content.review.noteHint')}
    {locale}
  >
    {#snippet control(attributes)}
      <textarea name="reviewNote.{target}" maxlength={REVIEW_NOTE_MAX} rows="3" {...attributes}
      ></textarea>
    {/snippet}
  </Field>
{/if}
