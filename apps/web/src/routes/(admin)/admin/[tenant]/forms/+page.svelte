<!-- A native inventory keeps form authoring available without the interactive content editor. -->
<script lang="ts">
  import { Actions, Button, Field, Notice, PageHeader } from '#lib/admin/ui/index.js';
  import { ui, refusalCopy } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
</script>

<svelte:head><title>{t('admin.forms.title')} · {data.tenant.name}</title></svelte:head>
<main class="page admin">
  <PageHeader
    title={t('admin.forms.title')}
    locale={data.locale}
    description={t('admin.forms.intro')}
  />
  {#if form && 'error' in form}<Notice tone="error" title={t('error.summary.title')}
      ><p>{refusalCopy(t, form)}</p></Notice
    >{/if}
  <ul>
    {#each data.forms as f}<li>
        <a href="/admin/{data.tenant.slug}/forms/{f.id}"
          >{f.list} ({t(`admin.forms.option.${f.kind}` as const)}) · {f.id}</a
        >
      </li>{/each}
  </ul>
  <form method="post" action="?/create" class="ui-fields">
    <Field id="kind" label={t('admin.forms.kind')} locale={data.locale}
      >{#snippet control(a)}<select {...a} name="kind"
          >{#each ['contact', 'signup', 'petition', 'rsvp'] as kind}<option value={kind}
              >{t(`admin.forms.option.${kind}` as 'admin.forms.option.signup')}</option
            >{/each}</select
        >{/snippet}</Field
    >
    <Actions><Button>{t('admin.forms.create')}</Button></Actions>
  </form>
</main>
