// The two subjects under "Status" in the sidebar (brief admin-operations-screens § 5): the
// overview and the log, as `subnav` in the page data of each (the contract of #87). Rejected:
// the log as a section at the foot of the status page (a filtered list with paging would push
// the verdict's page past its job) and tabs above it (tabs are for the parts of one item).
import { ui } from '../../../i18n/index.js';

export function statusSubnav(lang: string, base: string, current: 'overview' | 'audit') {
  const t = ui(lang);
  return [
    {
      label: t('admin.status.subnav.overview'),
      href: `${base}/status`,
      current: current === 'overview',
    },
    { label: t('admin.audit.title'), href: `${base}/status/audit`, current: current === 'audit' },
  ];
}
