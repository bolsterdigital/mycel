<!-- The site's usage against its limits (ADR 015), as on the dashboard widget and the usage
     section of the settings (brief #81 PR 3): one list, so both places count and format alike.
     Rejected: a generic component in lib/admin/ui (it knows the usage use case's shape). -->
<script lang="ts">
  import type { TenantUsage } from '@mycel/core';
  import { MetaList } from '#lib/admin/ui/index.js';
  import { fill, ui } from '../../i18n/index.js';

  let { usage, locale }: { usage: TenantUsage; locale: string } = $props();

  const t = $derived(ui(locale));
  const number = $derived(new Intl.NumberFormat(locale));
  const of = (used: number | string, max: number | string) =>
    fill(t('admin.usage.of'), {
      used: typeof used === 'number' ? number.format(used) : used,
      max: typeof max === 'number' ? number.format(max) : max,
    });
  const bytes = (n: number) =>
    new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: n >= 1024 ** 3 ? 'gigabyte' : 'megabyte',
      maximumFractionDigits: 1,
    }).format(n / (n >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2));
</script>

<MetaList
  items={[
    {
      term: t('admin.usage.supporters'),
      value: of(usage.supporters.used, usage.supporters.max),
    },
    { term: t('admin.usage.mail'), value: of(usage.mail.usedThisMonth, usage.mail.max) },
    {
      term: t('admin.usage.storage'),
      value: of(bytes(usage.storage.usedBytes), bytes(usage.storage.maxBytes)),
    },
    {
      term: t('admin.usage.operators'),
      value: of(usage.operators.used, usage.operators.max),
    },
    {
      term: t('admin.usage.customDomains'),
      value: of(usage.customDomains.used, usage.customDomains.max),
    },
  ]}
/>
