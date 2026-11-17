// The signed-in reader's own account on the reader page (ADR 016 rule 1, ADR 019 rule 7): the
// address, the access per tier, the newsletter lists with a button to leave each, the last
// sign-in and what the site keeps. Everything comes from `reader.account.get`, which reads the
// supporter of the session and nobody else; this module only puts it in the page's language and
// time zone. No address or list goes into a URL except the list a withdrawal just ended, which
// names a newsletter, not a person.
//
// Rejected: the membership buttons the brief names for later (change, pause, cancel): until the
// ledger offers them (ADR 005) the page states the access and offers nothing that pretends to.

import { pickAny, useCases, type Principal, type ReaderAccount } from '@mycel/core';
import { fill, plural, ui } from '../../../i18n/index.js';
import { runtime } from '../runtime.js';
import { sitePath, type Site } from '../site.js';
import { READER_PATH, readerVisitor } from './reader.js';

export interface ReaderAccountView {
  email: string;
  lastSeen: string | null;
  sessionEnds: string;
  access: { name: string; status: string; standing: boolean }[];
  lists: { list: string; label: string; button: string }[];
  withdrawAction: string;
  /** The list a withdrawal just ended, when it is no longer on the account. */
  withdrawn: string | null;
  retention: string;
}

export async function readerAccountView(
  site: Site,
  reader: Principal,
  locale: string,
  withdrawn: string | null
): Promise<ReaderAccountView> {
  const { invoker } = runtime();
  const t = ui(locale);
  const account: ReaderAccount = await invoker.run(useCases.getReaderAccount, reader, {});
  const { timeZone } = (await invoker.run(useCases.getSiteGeneral, readerVisitor(site), {})).value;
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone });
  const moment = new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone,
  });
  const at = (iso: string, format: Intl.DateTimeFormat) => format.format(new Date(iso));
  const days = account.activityRetentionDays;
  return {
    email: account.email,
    lastSeen: account.lastSeenAt ? at(account.lastSeenAt, moment) : null,
    sessionEnds: fill(t('reader.account.session'), {
      date: at(account.sessionExpiresAt, moment),
    }),
    access: account.access.map((entry) => ({
      name: pickAny(entry.name, locale, site.tenant.defaultLocale) ?? '',
      standing: entry.standing,
      status: !entry.standing
        ? fill(t('reader.account.access.ended'), { date: at(entry.until!, day) })
        : entry.until
          ? fill(t('reader.account.access.until'), { date: at(entry.until, day) })
          : t('reader.account.access.open'),
    })),
    lists: account.lists.map(({ list, status }) => ({
      list,
      label: status === 'pending' ? fill(t('reader.account.newsletters.pending'), { list }) : list,
      button: fill(t('reader.account.newsletters.withdraw'), { list }),
    })),
    withdrawAction: `${sitePath(site, READER_PATH)}?/withdraw`,
    withdrawn: withdrawn && !account.lists.some((l) => l.list === withdrawn) ? withdrawn : null,
    retention:
      days === 0 ? t('reader.account.retention.none') : plural(t, 'reader.account.retention', days),
  };
}
