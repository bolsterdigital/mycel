<!-- An event's when and where, between the lead and the hero image, where the public page
     shows them. The times are the site's wall clock: the hint names its zone, also for an
     operator with a zone of their own. -->
<script lang="ts">
  import { Field, Fieldset } from '#lib/admin/ui/index.js';
  import { ui } from '../../../i18n/index.js';

  let {
    locale,
    work,
    zone,
    v,
  }: {
    /** The admin's language. */
    locale: string;
    /** The content locale the form shows; the place is per locale. */
    work: string;
    /** The site's time zone, which the times are in. */
    zone: string;
    /** The form's value of a field, as the edit page reads it. */
    v: (name: string) => string;
  } = $props();
  const t = $derived(ui(locale));
</script>

<Fieldset legend={t('admin.content.event.title')}>
  <Field
    id="eventStartsAt"
    name="eventStartsAt"
    type="datetime-local"
    label={t('admin.content.event.startsAt')}
    hint={`${t('admin.content.event.zone')} ${zone}`}
    {locale}
    value={v('eventStartsAt')}
  />
  <Field
    id="eventEndsAt"
    name="eventEndsAt"
    type="datetime-local"
    label={t('admin.content.event.endsAt')}
    {locale}
    value={v('eventEndsAt')}
  />
  <Field
    id="eventLocation.{work}"
    name="eventLocation.{work}"
    label="{t('admin.content.event.location')} ({work})"
    hint={t('admin.content.event.locationHint')}
    {locale}
    maxlength={500}
    lang={work}
    value={v(`eventLocation.${work}`)}
  />
  <Field
    id="eventOnlineUrl"
    name="eventOnlineUrl"
    type="url"
    label={t('admin.content.event.onlineUrl')}
    hint={t('admin.content.event.onlineUrlHint')}
    {locale}
    maxlength={2048}
    value={v('eventOnlineUrl')}
  />
</Fieldset>
