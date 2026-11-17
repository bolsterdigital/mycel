// Every event type the platform itself writes has a sentence in both catalogues, and a type
// without one falls back to its name (brief MY-251 PR 2).

import type { TimelineEntry } from '@mycel/core';
import { describe, expect, it } from 'vitest';
import { ui } from '../../../i18n/index.js';
import { eventKey, eventSentence } from './words.js';

const entry = (fields: Partial<TimelineEntry> & Pick<TimelineEntry, 'type'>): TimelineEntry => ({
  id: 'e1',
  occurredAt: '2026-11-03T09:00:00.000Z',
  ...fields,
});
const names = {
  lists: { news: 'Nieuwsbrief' },
  campaigns: { c1: 'Red de bieb' },
  tiers: { t1: 'Vrienden' },
};

describe('supporter timeline words', () => {
  it('have a sentence for every type Mycel writes', () => {
    const written = [
      'newsletter.subscribed',
      'newsletter.unsubscribed',
      'consent.given',
      'consent.withdrawn',
      'petition.signed',
      'form.submitted',
      'supporter.email_changed',
      'access.granted',
      'access.revoked',
      'reader.signed_in',
      'donation.payment.succeeded',
      'donation.payment.failed',
    ] as const;
    expect(written.filter((type) => eventKey({ type }) === null)).toEqual([]);
  });

  it('say what happened with the name the page knows', () => {
    const nl = ui('nl');
    const say = (e: TimelineEntry) => eventSentence(nl, e, names);
    expect(say(entry({ type: 'newsletter.subscribed', list: 'news', confirmed: true }))).toBe(
      'Schreef zich in voor Nieuwsbrief'
    );
    expect(say(entry({ type: 'newsletter.subscribed', list: 'news', confirmed: false }))).toBe(
      'Schreef zich in voor Nieuwsbrief, nog niet bevestigd'
    );
    expect(say(entry({ type: 'consent.given', list: 'news' }))).toBe(
      'Bevestigde de inschrijving voor Nieuwsbrief'
    );
    expect(say(entry({ type: 'petition.signed', campaignId: 'c1' }))).toBe('Tekende Red de bieb');
    expect(say(entry({ type: 'newsletter.unsubscribed', list: 'news' }))).toBe(
      'Meldde zich af voor Nieuwsbrief'
    );
    expect(eventSentence(ui('en'), entry({ type: 'access.granted', tierId: 't1' }), names)).toBe(
      'Was given access to Vrienden'
    ); // A gift by its amount, in the page's locale (MY-252).
    const gift = { value: 2500, currency: 'EUR' };
    expect(say(entry({ type: 'donation.payment.succeeded', amount: gift }))).toBe('Gaf €\u00a025');
    expect(
      eventSentence(
        ui('en'),
        entry({ type: 'donation.payment.succeeded', amount: { value: 1250, currency: 'EUR' } }),
        names,
        'en'
      )
    ).toBe('Gave €12.50');
  });

  it('fall back to the list id, general words and the type name', () => {
    const nl = ui('nl');
    const say = (e: TimelineEntry) => eventSentence(nl, e, names);
    expect(say(entry({ type: 'newsletter.unsubscribed', list: 'oud' }))).toBe(
      'Meldde zich af voor oud'
    );
    expect(say(entry({ type: 'petition.signed', campaignId: 'weg' }))).toBe('Tekende een campagne');
    expect(say(entry({ type: 'access.revoked' }))).toBe(
      'Toegang tot een toegangsniveau ingetrokken'
    );
    expect(say(entry({ type: 'donation.started' }))).toBe('donation.started');
  });
});
