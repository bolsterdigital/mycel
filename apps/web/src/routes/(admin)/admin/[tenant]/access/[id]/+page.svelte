<!-- Slug and kind are asked once: core fixes them at create, so the edit form shows them as text.
     A paid tier also has its prices per interval and its signup page (MY-254 PR 4), and lists
     its members below the form: who, how much, until when paid. -->
<script lang="ts">
  import { page } from '$app/state';
  import {
    Badge,
    Fieldset,
    FormPage,
    Field,
    MetaList,
    Notice,
    Select,
    Table,
  } from '#lib/admin/ui/index.js';
  import { formatWhen } from '#lib/admin/format.js';
  import { perInterval } from '#lib/admin/donations/giving.js';
  import { ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/access`);
  const value = (key: string, initial = '') => form?.values?.[key] ?? initial;
  const title = $derived(t(data.tier ? 'admin.tiers.edit' : 'admin.tiers.new'));
  const euros = (cents: number | undefined) =>
    cents === undefined ? '' : (cents / 100).toFixed(cents % 100 ? 2 : 0);
  const now = new Date();
  const day = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });
</script>

<svelte:head><title>{title} · {data.tenant.name}</title></svelte:head>
<FormPage
  {title}
  locale={data.locale}
  submit={t('admin.tiers.save')}
  cancel={{ href: base, label: t('admin.tiers.title') }}
>
  {#snippet notices()}{#if form?.error}<Notice tone="error">{t(form.error)}</Notice
      >{:else if page.url.searchParams.has('saved')}<Notice tone="success"
        >{t('admin.tiers.saved')}</Notice
      >{/if}{/snippet}
  <input type="hidden" name="contentLocale" value={value('contentLocale', data.contentLocale)} />
  <input
    type="hidden"
    name="baseUpdatedAt"
    value={value('baseUpdatedAt', data.tier?.updatedAt ?? '')}
  />
  <Field
    id="tier-name"
    name="name"
    required
    maxlength={200}
    label={t('admin.tiers.name')}
    hint={t('admin.tiers.name.hint')}
    locale={data.locale}
    value={value('name', data.tier?.name[data.contentLocale])}
  />
  <Field
    id="tier-description"
    label={t('admin.tiers.description')}
    hint={t('admin.tiers.description.hint')}
    locale={data.locale}
  >
    {#snippet control(attributes)}<textarea
        {...attributes}
        name="description"
        rows="3"
        maxlength="2000"
        >{value('description', data.tier?.description?.[data.contentLocale])}</textarea
      >{/snippet}
  </Field>
  {#if data.tier}
    <MetaList
      items={[
        { term: t('admin.tiers.slug'), value: data.tier.slug },
        { term: t('admin.tiers.kind'), value: t(`admin.tiers.kind.${data.tier.kind}`) },
      ]}
    />
  {:else}
    <Field
      id="tier-slug"
      name="slug"
      maxlength={63}
      pattern={'[a-z0-9][a-z0-9-]{0,62}'}
      autocapitalize="off"
      spellcheck={false}
      label={t('admin.tiers.slug')}
      hint={t('admin.tiers.slug.hint')}
      locale={data.locale}
      value={value('slug')}
    />
    <Select
      id="tier-kind"
      name="kind"
      label={t('admin.tiers.kind')}
      hint={t('admin.tiers.kind.hint')}
      locale={data.locale}
      value={value('kind', 'free')}
      options={[
        { value: 'free', label: t('admin.tiers.kind.free') },
        { value: 'paid', label: t('admin.tiers.kind.paid') },
      ]}
    />
  {/if}
  <Field
    id="tier-order"
    name="order"
    type="number"
    min={0}
    max={10000}
    required
    label={t('admin.tiers.order')}
    locale={data.locale}
    value={value('order', String(data.tier?.order ?? 0))}
  />
  {#if !data.tier || data.tier.kind === 'paid'}
    <Fieldset legend={t('admin.tiers.membership')} hint={t('admin.tiers.membership.hint')}>
      <Field
        id="tier-price-month"
        name="price-month"
        inputmode="decimal"
        autocomplete="off"
        maxlength={12}
        size="s"
        unit="€"
        label={t('admin.tiers.price.month')}
        hint={t('admin.tiers.price.hint')}
        locale={data.locale}
        value={value('price-month', euros(data.tier?.prices.month))}
      />
      <Field
        id="tier-price-year"
        name="price-year"
        inputmode="decimal"
        autocomplete="off"
        maxlength={12}
        size="s"
        unit="€"
        label={t('admin.tiers.price.year')}
        hint={t('admin.tiers.price.hint')}
        locale={data.locale}
        value={value('price-year', euros(data.tier?.prices.year))}
      />
      <Field
        id="tier-signup"
        name="signupPath"
        maxlength={200}
        autocapitalize="off"
        spellcheck={false}
        label={t('admin.tiers.signupPath')}
        hint={t('admin.tiers.signupPath.hint')}
        locale={data.locale}
        value={value('signupPath', data.tier?.signupPath ?? '')}
      />
      {#if data.tier}
        <MetaList
          items={[{ term: t('admin.tiers.priceVersion'), value: String(data.tier.priceVersion) }]}
        />
      {/if}
    </Fieldset>
  {/if}
  {#snippet after()}{#if data.members}
      <section class="tier-members" aria-labelledby="tier-members">
        <h2 id="tier-members">{t('admin.tiers.members')}</h2>
        {#if data.members.length}
          <Table
            id="members"
            caption={t('admin.tiers.members')}
            hideCaption
            stack
            card
            columns={[
              { key: 'member', label: t('admin.tiers.members.member') },
              { key: 'amount', label: t('admin.donations.amount') },
              { key: 'until', label: t('admin.tiers.members.until') },
            ]}
          >
            {#snippet rows()}{#each data.members ?? [] as m (m.id)}
                <tr
                  ><th scope="row" data-label={t('admin.tiers.members.member')} class="tier-member"
                    >{#if m.email && m.supporterId}<a
                        href="/admin/{data.tenant.slug}/supporters/{m.supporterId}">{m.email}</a
                      >{:else}{t('admin.donations.knownGiver')}{/if}</th
                  >
                  <td data-label={t('admin.donations.amount')}
                    ><a href="/admin/{data.tenant.slug}/donations/recurring/{m.id}"
                      >{perInterval(t, m.amount, m.currency, m.interval, data.locale)}</a
                    ></td
                  >
                  <td data-label={t('admin.tiers.members.until')}
                    >{#if m.paidThrough}{@const at = day(m.paidThrough)}<time
                        datetime={at.iso}
                        title={at.full}>{at.text}</time
                      >{:else}{t('admin.giving.status.pending')}{/if}{#if m.cancelAtPeriodEnd}
                      <Badge tone="warning">{t('admin.tiers.members.stops')}</Badge>{/if}</td
                  ></tr
                >
              {/each}{/snippet}
          </Table>
        {:else}
          <p>{t('admin.tiers.members.none')}</p>
        {/if}
      </section>
    {/if}
  {/snippet}
</FormPage>

<style>
  .tier-member {
    overflow-wrap: anywhere;
  }
</style>
