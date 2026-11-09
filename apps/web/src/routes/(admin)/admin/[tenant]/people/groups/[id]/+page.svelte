<!-- Native checkboxes and positions work without dragging or JavaScript. -->
<script lang="ts">
  import { page } from '$app/state';
  import { FormPage, Field, Fieldset, Notice } from '#lib/admin/ui/index.js';
  import { ui } from '../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/people`);
  const value = (key: string, initial = '') => form?.values?.[key] ?? initial;
  const chosen = $derived(form?.personIds ?? data.group?.personIds ?? []);
  const people = $derived(
    [...data.people].sort((a, b) => {
      const order = (id: string) => {
        const i = chosen.indexOf(id);
        return i < 0 ? 10000 : i;
      };
      return order(a.id) - order(b.id);
    })
  );
</script>

<svelte:head
  ><title
    >{t(data.group ? 'admin.people.editGroup' : 'admin.people.newGroup')} · {data.tenant
      .name}</title
  ></svelte:head
>
<FormPage
  title={t(data.group ? 'admin.people.editGroup' : 'admin.people.newGroup')}
  locale={data.locale}
  submit={t('admin.people.save')}
  cancel={{ href: `${base}/groups`, label: t('admin.people.groups') }}
>
  {#snippet notices()}{#if form?.error}<Notice tone="error">{t(form.error)}</Notice
      >{:else if page.url.searchParams.has('saved')}<Notice tone="success"
        >{t('admin.people.saved')}</Notice
      >{/if}{/snippet}
  <input type="hidden" name="contentLocale" value={value('contentLocale', data.contentLocale)} />
  <input
    type="hidden"
    name="baseUpdatedAt"
    value={value('baseUpdatedAt', data.group?.updatedAt ?? '')}
  />
  <Field
    id="group-name"
    name="name"
    required
    maxlength={200}
    label={t('admin.people.name')}
    locale={data.locale}
    value={value('name', data.group?.name[data.contentLocale])}
  />
  <Field
    id="group-order"
    name="order"
    type="number"
    min={0}
    max={10000}
    required
    label={t('admin.people.order')}
    locale={data.locale}
    value={value('order', String(data.group?.order ?? 0))}
  />
  <Fieldset legend={t('admin.people.members')}>
    {#each people as person}
      <div class="ui-choice">
        <input
          type="checkbox"
          id="member-{person.id}"
          name="personIds"
          value={person.id}
          checked={chosen.includes(person.id)}
        /><label for="member-{person.id}">{person.name}</label>
      </div>
      <Field
        id="position-{person.id}"
        name="position.{person.id}"
        type="number"
        min={0}
        max={10000}
        label={`${t('admin.people.position')}: ${person.name}`}
        locale={data.locale}
        value={value(
          `position.${person.id}`,
          chosen.includes(person.id) ? String(chosen.indexOf(person.id) + 1) : ''
        )}
      />
    {/each}
  </Fieldset>
</FormPage>
