import { AttentionSource, type AttentionItem } from '@mycel/core';
import { describe, expect, it } from 'vitest';
import { ui } from '../../../i18n/index.js';
import { attentionHref, attentionText, taskName } from './words.js';

const ID = '01890000-0000-7000-8000-000000000001';
const item = (over: Partial<AttentionItem>): AttentionItem => ({
  key: 'x',
  source: 'job',
  subjectId: ID,
  locale: null,
  detail: null,
  count: 1,
  since: '2026-11-06T09:00:00.000Z',
  unread: true,
  ...over,
});

describe('a notification in words and where it is solved', () => {
  it('has a sentence and a destination for every source, in both admin languages', () => {
    for (const locale of ['nl', 'en']) {
      const t = ui(locale);
      for (const source of AttentionSource.options) {
        const one = item({ source, detail: source === 'connection' ? 'webhook' : 'Titel' });
        expect(attentionText(t, one), `${locale} ${source}`).not.toMatch(/\{|admin\./);
        expect(attentionHref('/admin/probe', one)).toMatch(/^\/admin\/probe\/\w+/);
      }
    }
  });

  it('names a job as the status page does, and counts mail and erasures', () => {
    const t = ui('nl');
    expect(attentionText(t, item({ detail: 'content.publish' }))).toBe(
      `${taskName(t, 'content.publish')} mislukte bij elke poging`
    );
    expect(attentionText(t, item({ detail: 'e2e.other' }))).toBe(
      'Andere taak mislukte bij elke poging'
    );
    expect(attentionText(t, item({ source: 'mail', subjectId: null, count: 3 }))).toBe(
      '3 mails zijn opgegeven.'
    );
  });

  it('leads an offer to its locale in the editor and a connection to its page', () => {
    const offer = item({ source: 'review', locale: 'en', detail: '' });
    expect(attentionHref('/admin/probe', offer)).toBe(`/admin/probe/content/${ID}?locale=en`);
    expect(attentionText(ui('en'), offer)).toBe('(no title) (en) is offered for publication');
    expect(attentionHref('/admin/probe', item({ source: 'connection' }))).toBe(
      `/admin/probe/connections/${ID}`
    );
  });
});
